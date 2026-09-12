/**
 * Mongo-backed fixed-window rate limiter for API routes.
 *
 * Why Mongo (not in-memory): the app runs on serverless/multi-instance hosting, so an in-process
 * counter would be per-lambda and trivially bypassable. Every instance shares the `ratelimits`
 * collection instead.
 *
 * Hot path is a single atomic `findOneAndUpdate` (upsert + `$inc`). Only when a bucket exists but
 * its window has already elapsed do we take a second atomic step to reset it in place.
 */
import { NextResponse } from "next/server";
import net from "node:net";
import { connectMongo } from "@/lib/mongodb";
import { RateLimitModel } from "@/lib/models/RateLimit";
import { debugError } from "@/lib/debug";

export type RateLimitInput = {
  /** Bucket id, e.g. `unlock:<ip>:<shareId>`. Callers must namespace keys per endpoint. */
  key: string;
  /** Max hits allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injectable clock (tests). Defaults to `Date.now()`. */
  now?: number;
};

export type RateLimitResult = {
  /** `true` when the request is within the limit and may proceed. */
  ok: boolean;
  /** Hits left in the current window (0 when blocked). */
  remaining: number;
  /** Seconds until the window resets (0 when `ok`). */
  retryAfterSec: number;
};

type RateLimitDoc = { count?: unknown; expiresAt?: unknown };

/** Return whether an error is a Mongo duplicate-key error (E11000). */
function isDupKeyError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: unknown }).code === 11000);
}

/** Convert a raw bucket document into a `RateLimitResult`. */
function toResult(doc: RateLimitDoc | null, opts: { limit: number; windowMs: number; now: number }): RateLimitResult {
  const count = typeof doc?.count === "number" && Number.isFinite(doc.count) ? doc.count : 1;
  const expiresAtMs =
    doc?.expiresAt instanceof Date ? doc.expiresAt.getTime() : opts.now + opts.windowMs;
  const ok = count <= opts.limit;
  return {
    ok,
    remaining: Math.max(0, opts.limit - count),
    retryAfterSec: ok ? 0 : Math.max(1, Math.ceil((expiresAtMs - opts.now) / 1000)),
  };
}

/**
 * Count one hit against `key` and report whether the caller is still within `limit`.
 *
 * Semantics: fixed window. The first hit opens a window of `windowMs`; hits are counted until it
 * ends, after which the next hit opens a fresh window. The hit is always recorded (even when the
 * result is `ok: false`), so a client hammering an endpoint never "earns" a reset early.
 *
 * Fails open: if Mongo is unreachable the request is allowed and the error is logged, because
 * every guarded endpoint needs Mongo anyway and a limiter outage should not become an outage.
 */
export async function rateLimit(input: RateLimitInput): Promise<RateLimitResult> {
  const key = String(input.key ?? "").trim();
  const limit = Math.max(1, Math.floor(input.limit));
  const windowMs = Math.max(1000, Math.floor(input.windowMs));
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  if (!key) throw new Error("rateLimit: key is required");

  const nowDate = new Date(now);
  const windowEnd = new Date(now + windowMs);

  try {
    await connectMongo();

    // Up to two attempts: the second covers the race where another request reset the bucket
    // between our failed upsert and our reset (the reset then matches nothing).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // 1) Atomic hit within a live window (or open a new bucket when none exists).
        const doc = (await RateLimitModel.findOneAndUpdate(
          { key, expiresAt: { $gt: nowDate } },
          {
            $inc: { count: 1 },
            $setOnInsert: { key, windowStart: nowDate, expiresAt: windowEnd },
          },
          { upsert: true, new: true },
        ).lean()) as RateLimitDoc | null;
        return toResult(doc, { limit, windowMs, now });
      } catch (err) {
        if (!isDupKeyError(err)) throw err;
      }

      // 2) A bucket exists but its window elapsed (TTL hasn't reaped it yet): reset it in place.
      const reset = (await RateLimitModel.findOneAndUpdate(
        { key, expiresAt: { $lte: nowDate } },
        { $set: { count: 1, windowStart: nowDate, expiresAt: windowEnd } },
        { new: true },
      ).lean()) as RateLimitDoc | null;
      if (reset) return toResult(reset, { limit, windowMs, now });
      // Someone else reset it first; loop back and count our hit against the new window.
    }

    // Extremely unlikely (two lost races); allow the request rather than block a real user.
    return { ok: true, remaining: 0, retryAfterSec: 0 };
  } catch (err) {
    debugError(1, "[rateLimit] failed open", { key, message: err instanceof Error ? err.message : String(err) });
    return { ok: true, remaining: limit, retryAfterSec: 0 };
  }
}

/**
 * Trim a proxy-provided address down to a bare IP (strips ports / IPv6 brackets).
 *
 * Returns `null` for anything that is not an IP literal, so a caller sending arbitrary text in a
 * forwarding header cannot mint a fresh bucket per request (they collapse into `"unknown"`).
 */
function normalizeIp(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 128) return null;
  let ip = s;
  if (s.startsWith("[") && s.includes("]")) {
    ip = s.slice(1, s.indexOf("]")).trim();
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) {
    ip = s.slice(0, s.lastIndexOf(":"));
  }
  return ip && net.isIP(ip) ? ip : null;
}

/**
 * Best-effort client IP for rate-limit keys.
 *
 * Reads the first hop of `x-forwarded-for` (what Vercel/most proxies set to the real client),
 * then `x-real-ip`. Returns `"unknown"` when neither is present so callers always get a usable key
 * (all unknown callers then share one bucket, which is the safe direction).
 */
export function clientIpFromRequest(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0] ?? "";
    const ip = normalizeIp(first);
    if (ip) return ip;
  }
  const real = request.headers.get("x-real-ip");
  if (real) {
    const ip = normalizeIp(real);
    if (ip) return ip;
  }
  return "unknown";
}

/**
 * Build the standard 429 response for a blocked request (includes `Retry-After`).
 */
export function rateLimitedResponse(result: RateLimitResult, publicMessage = "Too many requests. Please try again later.") {
  const retryAfter = Math.max(1, Math.floor(result.retryAfterSec));
  return NextResponse.json(
    { error: publicMessage, retryAfterSeconds: retryAfter },
    { status: 429, headers: { "retry-after": String(retryAfter), "cache-control": "no-store" } },
  );
}
