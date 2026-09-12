import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  assertSafeOutboundUrl,
  isPrivateAddress,
  safeFetchUrl,
  SafeFetchError,
} from "../../src/lib/http/safeFetchUrl";

describe("safeFetchUrl", () => {
  describe("isPrivateAddress", () => {
    it("flags loopback, link-local, private, CGNAT and metadata IPv4 ranges", () => {
      for (const ip of [
        "127.0.0.1",
        "127.255.255.254",
        "10.0.0.1",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254",
        "169.254.0.1",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "255.255.255.255",
      ]) {
        expect(isPrivateAddress(ip), ip).toBe(true);
      }
    });

    it("allows public IPv4", () => {
      for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1", "100.128.0.1", "93.184.216.34"]) {
        expect(isPrivateAddress(ip), ip).toBe(false);
      }
    });

    it("flags loopback, link-local, ULA, mapped-private and multicast IPv6", () => {
      for (const ip of [
        "::1",
        "::",
        "fe80::1",
        "fe80::1%en0",
        "fc00::1",
        "fd12:3456::1",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "::ffff:169.254.169.254",
        "64:ff9b::a9fe:a9fe",
        "ff02::1",
      ]) {
        expect(isPrivateAddress(ip), ip).toBe(true);
      }
    });

    it("allows public IPv6", () => {
      for (const ip of ["2606:4700:4700::1111", "::ffff:8.8.8.8", "2a00:1450:4001:80e::200e"]) {
        expect(isPrivateAddress(ip), ip).toBe(false);
      }
    });
  });

  describe("assertSafeOutboundUrl", () => {
    it("rejects non-http(s) schemes", async () => {
      await expect(assertSafeOutboundUrl(new URL("file:///etc/passwd"))).rejects.toMatchObject({
        code: "UNSUPPORTED_PROTOCOL",
      });
      await expect(assertSafeOutboundUrl(new URL("ftp://example.com/x"))).rejects.toMatchObject({
        code: "UNSUPPORTED_PROTOCOL",
      });
    });

    it("rejects localhost and private IP literals", async () => {
      await expect(assertSafeOutboundUrl(new URL("http://localhost:3000/"))).rejects.toMatchObject({
        code: "PRIVATE_ADDRESS",
      });
      await expect(assertSafeOutboundUrl(new URL("http://127.0.0.1/"))).rejects.toMatchObject({
        code: "PRIVATE_ADDRESS",
      });
      await expect(assertSafeOutboundUrl(new URL("http://169.254.169.254/latest/meta-data"))).rejects.toMatchObject({
        code: "PRIVATE_ADDRESS",
      });
      await expect(assertSafeOutboundUrl(new URL("http://[::1]/"))).rejects.toMatchObject({
        code: "PRIVATE_ADDRESS",
      });
    });

    it("allows private targets only when explicitly opted in", async () => {
      await expect(
        assertSafeOutboundUrl(new URL("http://127.0.0.1/"), { allowPrivateNetwork: true }),
      ).resolves.toBeUndefined();
    });
  });

  describe("against a local server (allowPrivateNetwork)", () => {
    let server: http.Server;
    let base = "";

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/ok") {
          res.writeHead(200, { "content-type": "application/pdf", "set-cookie": "a=b; Path=/" });
          res.end("%PDF-1.4 hello");
          return;
        }
        if (url.pathname === "/big") {
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.end(Buffer.alloc(64 * 1024, 1));
          return;
        }
        if (url.pathname === "/big-declared") {
          res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1000000" });
          res.end(Buffer.alloc(10, 1));
          return;
        }
        if (url.pathname.startsWith("/redirect/")) {
          const n = Number(url.pathname.slice("/redirect/".length)) || 0;
          res.writeHead(302, { location: n <= 1 ? "/ok" : `/redirect/${n - 1}` });
          res.end();
          return;
        }
        if (url.pathname === "/redirect-external") {
          res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
          res.end();
          return;
        }
        if (url.pathname === "/redirect-noloc") {
          res.writeHead(302);
          res.end();
          return;
        }
        if (url.pathname === "/slow") {
          setTimeout(() => {
            res.writeHead(200);
            res.end("late");
          }, 2_000);
          return;
        }
        res.writeHead(404);
        res.end("nope");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      base = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const opts = { maxBytes: 16 * 1024, timeoutMs: 5_000, allowPrivateNetwork: true } as const;

    it("refuses loopback without the opt-in", async () => {
      await expect(safeFetchUrl(`${base}/ok`, { maxBytes: 1024, timeoutMs: 1000 })).rejects.toMatchObject({
        code: "PRIVATE_ADDRESS",
      });
    });

    it("returns the buffered body, final url and set-cookies", async () => {
      const r = await safeFetchUrl(`${base}/ok`, opts);
      expect(r.response.status).toBe(200);
      expect(r.body.toString("utf8")).toBe("%PDF-1.4 hello");
      expect(r.finalUrl).toBe(`${base}/ok`);
      expect(r.setCookies).toEqual(["a=b; Path=/"]);
    });

    it("returns non-2xx responses without throwing", async () => {
      const r = await safeFetchUrl(`${base}/missing`, opts);
      expect(r.response.status).toBe(404);
      expect(r.body.toString("utf8")).toBe("nope");
    });

    it("follows up to 3 re-validated redirect hops and rejects more", async () => {
      const ok = await safeFetchUrl(`${base}/redirect/3`, opts);
      expect(ok.response.status).toBe(200);
      expect(ok.finalUrl).toBe(`${base}/ok`);

      await expect(safeFetchUrl(`${base}/redirect/4`, opts)).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
      await expect(safeFetchUrl(`${base}/redirect-noloc`, opts)).rejects.toMatchObject({
        code: "MISSING_REDIRECT_LOCATION",
      });
    });

    it("re-validates redirect targets (blocks a hop to a metadata address)", async () => {
      await expect(
        safeFetchUrl(`${base}/redirect-external`, { ...opts, allowPrivateNetwork: false }),
      ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    });

    it("aborts once the body exceeds maxBytes (streamed and declared)", async () => {
      await expect(safeFetchUrl(`${base}/big`, opts)).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
      await expect(safeFetchUrl(`${base}/big-declared`, opts)).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
    });

    it("times out", async () => {
      const err = await safeFetchUrl(`${base}/slow`, { ...opts, timeoutMs: 200 }).catch((e) => e);
      expect(err).toBeInstanceOf(SafeFetchError);
      expect((err as SafeFetchError).code).toBe("TIMEOUT");
    });
  });
});
