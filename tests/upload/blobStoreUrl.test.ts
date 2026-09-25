/**
 * `isBlobStoreUrl`: the gate a stored `blobUrl` passes before it is redirected to or copied
 * (code review 2026-09-23, docs/uploads Low: two routes handed out stored URLs unchecked).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isBlobStoreUrl } from "../../src/lib/blob/serverClientUploadRoute";

const ENV = { ...process.env };

describe("isBlobStoreUrl", () => {
  beforeEach(() => {
    process.env.BLOB_BASE_URL = "https://abc123.public.blob.vercel-storage.com";
  });
  afterEach(() => {
    process.env = { ...ENV };
  });

  it("accepts an https URL on the configured store host", () => {
    expect(isBlobStoreUrl("https://abc123.public.blob.vercel-storage.com/docs/d/uploads/u/x.pdf")).toBe(true);
  });

  it("refuses another host, plain http, and garbage", () => {
    expect(isBlobStoreUrl("https://evil.example.com/x.pdf")).toBe(false);
    expect(isBlobStoreUrl("https://other.public.blob.vercel-storage.com/x.pdf")).toBe(false);
    expect(isBlobStoreUrl("http://abc123.public.blob.vercel-storage.com/x.pdf")).toBe(false);
    expect(isBlobStoreUrl("not a url")).toBe(false);
    expect(isBlobStoreUrl("")).toBe(false);
  });
});
