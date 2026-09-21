/**
 * SSRF-safe fetch for user-supplied URLs.
 *
 * Guarantees:
 * - Only `http:`/`https:` URLs are fetched.
 * - The hostname is resolved with `dns.promises.lookup` and every resolved address must be
 *   public (loopback, link-local/metadata, private, CGNAT, multicast and unspecified ranges
 *   are rejected).
 * - The connection is **pinned** to the validated addresses: the request is issued through
 *   `node:http`/`node:https` with a custom `lookup` that only ever returns those addresses, so a
 *   DNS-rebinding host (public answer first, private answer on the second resolution) cannot make
 *   the socket connect anywhere the check did not see. TLS still validates against the hostname.
 * - Redirects are never followed automatically; each hop is re-validated (and re-pinned),
 *   up to `maxRedirects` hops (default 3).
 * - The body is streamed and aborted as soon as it exceeds `maxBytes`, and the whole request
 *   is bounded by `timeoutMs`.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";

export type SafeFetchOptions = {
  /** Maximum number of body bytes to buffer; larger responses abort with `BODY_TOO_LARGE`. */
  maxBytes: number;
  /** Overall timeout (DNS + connect + headers + body) in milliseconds. */
  timeoutMs: number;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Maximum number of redirect hops to follow (each re-validated). Default 3. */
  maxRedirects?: number;
  /**
   * Skip the private-network address check.
   *
   * Only meant for local development (e.g. fetching from the app's own `localhost` origin);
   * callers must gate this on `NODE_ENV !== "production"`.
   */
  allowPrivateNetwork?: boolean;
};

export type SafeFetchResult = {
  /** The final response (body already consumed into `body`). */
  response: Response;
  /** Buffered response body (at most `maxBytes`). */
  body: Buffer;
  /** URL of the final hop (after redirects). */
  finalUrl: string;
  /** `Set-Cookie` headers from the final response. */
  setCookies: string[];
};

/** Error thrown by `safeFetchUrl` with a stable machine-readable `code`. */
export class SafeFetchError extends Error {
  code:
    | "INVALID_URL"
    | "UNSUPPORTED_PROTOCOL"
    | "DNS_FAILED"
    | "PRIVATE_ADDRESS"
    | "TOO_MANY_REDIRECTS"
    | "MISSING_REDIRECT_LOCATION"
    | "BODY_TOO_LARGE"
    | "TIMEOUT";

  constructor(code: SafeFetchError["code"], message: string) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Parse a dotted IPv4 string into its 4 octets (or null). */
function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

/** Return whether an IPv4 address is in a non-public range. */
function isPrivateIpv4(ip: string): boolean {
  const o = ipv4Octets(ip);
  if (!o) return true; // unparsable => treat as unsafe
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 (unspecified / "this" network)
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 (CGNAT)
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4) + broadcast
  return false;
}

/** Expand an IPv6 address into 8 16-bit groups (or null when unparsable). */
function ipv6Groups(ip: string): number[] | null {
  let s = ip;
  // Strip zone id (fe80::1%eth0).
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // Embedded IPv4 tail (::ffff:1.2.3.4).
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const o = ipv4Octets(tail);
    if (!o) return null;
    s = `${s.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const parts = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const nums = parts.map((p) => (p === "" ? NaN : parseInt(p, 16)));
  if (nums.length !== 8 || nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

/** Return whether an IPv6 address is in a non-public range. */
function isPrivateIpv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true; // unparsable => treat as unsafe
  const allZeroButLast = g.slice(0, 7).every((x) => x === 0);
  if (allZeroButLast && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) => apply IPv4 rules.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    if (g[5] === 0xffff || g[6] !== 0 || g[7] > 1) return isPrivateIpv4(v4);
  }
  // 64:ff9b::/96 (NAT64) => embedded IPv4.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPrivateIpv4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

/** Return whether an IP literal (v4 or v6) is in a non-public range. */
export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true;
}

/**
 * Validate a URL for outbound fetching (protocol + resolved addresses) and return the validated
 * address list the connection must be pinned to (`null` when `allowPrivateNetwork` skips the check).
 * Throws `SafeFetchError` when unsafe.
 */
export async function resolveSafeOutboundAddresses(
  input: URL,
  opts?: { allowPrivateNetwork?: boolean },
): Promise<string[] | null> {
  if (input.protocol !== "http:" && input.protocol !== "https:") {
    throw new SafeFetchError("UNSUPPORTED_PROTOCOL", "Only http(s) URLs are supported");
  }
  if (opts?.allowPrivateNetwork) return null;

  // Strip IPv6 brackets for literal hosts.
  const hostname = input.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new SafeFetchError("PRIVATE_ADDRESS", "URL host is not allowed");
  }

  let addresses: Array<{ address: string }>;
  if (net.isIP(hostname)) {
    addresses = [{ address: hostname }];
  } else {
    try {
      addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    } catch (e) {
      // The resolver's own text ("getaddrinfo ENOTFOUND …") names a Node API the caller did not
      // call and offers nothing to do about it. Every other refusal in this family says what to try
      // instead; this one now does too.
      throw new SafeFetchError(
        "DNS_FAILED",
        "Could not resolve the host in that URL. Check the domain is right and publicly reachable, or send the file " +
          "directly instead of by URL.",
      );
    }
  }
  if (!addresses.length) {
    throw new SafeFetchError(
      "DNS_FAILED",
      "Could not resolve the host in that URL. Check the domain is right and publicly reachable, or send the file " +
        "directly instead of by URL.",
    );
  }
  for (const a of addresses) {
    if (isPrivateAddress(a.address)) {
      throw new SafeFetchError("PRIVATE_ADDRESS", "URL resolves to a non-public address");
    }
  }
  return addresses.map((a) => a.address);
}

/**
 * Validate a URL for outbound fetching: protocol + resolved addresses.
 * Throws `SafeFetchError` when unsafe.
 */
export async function assertSafeOutboundUrl(input: URL, opts?: { allowPrivateNetwork?: boolean }): Promise<void> {
  await resolveSafeOutboundAddresses(input, opts);
}

/**
 * Build a `lookup` function for `http.request` that only ever answers with `addresses`
 * (the list validated by `resolveSafeOutboundAddresses`), honouring the requested family.
 */
function pinnedLookup(addresses: string[]): NonNullable<http.RequestOptions["lookup"]> {
  const pinned = addresses
    .map((address) => ({ address, family: net.isIP(address) }))
    .filter((a) => a.family === 4 || a.family === 6);
  const lookup = (_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const o = (options && typeof options === "object" ? options : {}) as { all?: boolean; family?: unknown };
    const wanted = o.family === 6 || o.family === "IPv6" ? 6 : o.family === 4 || o.family === "IPv4" ? 4 : 0;
    const list = wanted ? pinned.filter((a) => a.family === wanted) : pinned;
    if (!list.length) {
      callback(new SafeFetchError("DNS_FAILED", "No validated address for the requested family"));
      return;
    }
    if (o.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  };
  return lookup as unknown as NonNullable<http.RequestOptions["lookup"]>;
}

/**
 * Issue one GET through `node:http`/`node:https`, pinned to `addresses` when given, and expose the
 * result as a web `Response` (headers copied verbatim; body streamed) so callers keep one API.
 */
function pinnedRequest(
  url: URL,
  params: { headers: Record<string, string>; addresses: string[] | null; signal: AbortSignal },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        headers: params.headers,
        signal: params.signal,
        ...(params.addresses ? { lookup: pinnedLookup(params.addresses) } : {}),
      },
      (res) => {
        const headers = new Headers();
        const raw = res.rawHeaders;
        for (let i = 0; i + 1 < raw.length; i += 2) {
          try {
            headers.append(raw[i], raw[i + 1]);
          } catch {
            // skip headers the Fetch spec refuses (invalid names/values)
          }
        }
        const code = res.statusCode ?? 0;
        const status = code >= 200 && code <= 599 ? code : 502;
        const nullBody = status === 204 || status === 205 || status === 304;
        if (nullBody) res.resume();
        const body = nullBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status, headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Read a response body into a Buffer, aborting once `maxBytes` is exceeded. */
async function readBodyBounded(res: Response, maxBytes: number, abort: AbortController): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    abort.abort();
    throw new SafeFetchError("BODY_TOO_LARGE", `Response exceeds ${maxBytes} bytes`);
  }
  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        abort.abort();
        throw new SafeFetchError("BODY_TOO_LARGE", `Response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total);
}

/** Extract `Set-Cookie` headers (Node's fetch exposes `getSetCookie`). */
function setCookiesFrom(res: Response): string[] {
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

/**
 * Fetch a user-supplied URL safely (see module docs), returning the buffered body.
 *
 * Non-2xx responses are returned as-is (callers inspect `response.status`); only transport,
 * validation, size and timeout failures throw (`SafeFetchError` or the underlying fetch error).
 */
export async function safeFetchUrl(url: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxRedirects = Math.max(0, Math.floor(opts.maxRedirects ?? 3));
  const maxBytes = Math.max(1, Math.floor(opts.maxBytes));
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs));

  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new SafeFetchError("INVALID_URL", "Invalid URL");
  }

  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
  const baseHeaders: Record<string, string> = { ...(opts.headers ?? {}) };

  try {
    for (let hop = 0; ; hop++) {
      const addresses = await resolveSafeOutboundAddresses(current, { allowPrivateNetwork: opts.allowPrivateNetwork });

      // Pinned to the addresses validated above (never a second, unvalidated DNS resolution).
      const res = await pinnedRequest(current, { headers: baseHeaders, addresses, signal });

      if (REDIRECT_STATUSES.has(res.status)) {
        // Drain/cancel the redirect body so the connection is released.
        try {
          await res.body?.cancel();
        } catch {
          // ignore
        }
        if (hop >= maxRedirects) {
          throw new SafeFetchError("TOO_MANY_REDIRECTS", `Too many redirects (max ${maxRedirects})`);
        }
        const location = res.headers.get("location");
        if (!location) throw new SafeFetchError("MISSING_REDIRECT_LOCATION", "Redirect without Location header");
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new SafeFetchError("INVALID_URL", "Invalid redirect Location");
        }
        // Do not leak cookies/authorization across origins on redirect.
        if (next.origin !== current.origin) {
          delete baseHeaders.cookie;
          delete baseHeaders.Cookie;
          delete baseHeaders.authorization;
          delete baseHeaders.Authorization;
        }
        current = next;
        continue;
      }

      const body = await readBodyBounded(res, maxBytes, abort);
      return { response: res, body, finalUrl: current.toString(), setCookies: setCookiesFrom(res) };
    }
  } catch (e) {
    if (e instanceof SafeFetchError) throw e;
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || (name === "AbortError" && !abort.signal.aborted)) {
      throw new SafeFetchError("TIMEOUT", `Request timed out after ${timeoutMs}ms`);
    }
    throw e;
  }
}
