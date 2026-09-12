import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertAllowedTestPathname,
  CLIENT_UPLOAD_MAX_SIZE_BYTES,
  getBlobStoreHost,
  isBlobPathnameForUpload,
  isBlobStoreHost,
  isBlobUrlForUpload,
  parseDocUploadBlobPathname,
  parseOrgAvatarBlobPathname,
} from "../../src/lib/blob/serverClientUploadRoute";
import {
  DOC_BLOB_PREFIX,
  ORG_AVATAR_PREFIX,
  TEST_BLOB_PREFIX,
} from "../../src/lib/blob/clientUpload";

const DOC_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const UPLOAD_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";
const ORG_ID = "cccccccccccccccccccccccc";

describe("serverClientUploadRoute", () => {
  it("assertAllowedTestPathname allows the production prefixes", () => {
    expect(() => assertAllowedTestPathname(`${DOC_BLOB_PREFIX}doc1/uploads/u1/x.pdf`)).not.toThrow();
    expect(() => assertAllowedTestPathname(`${ORG_AVATAR_PREFIX}org1/x.png`)).not.toThrow();
  });

  it("assertAllowedTestPathname rejects the client-tests prefix and other prefixes", () => {
    expect(() => assertAllowedTestPathname(`${TEST_BLOB_PREFIX}abc`)).toThrow(/Invalid pathname/i);
    expect(() => assertAllowedTestPathname("private/secret.txt")).toThrow(/Invalid pathname/i);
  });

  it("exposes a reasonable max size constant (sanity)", () => {
    expect(CLIENT_UPLOAD_MAX_SIZE_BYTES).toBeGreaterThan(1_000_000);
  });

  describe("parseDocUploadBlobPathname", () => {
    it("parses docs/{docId}/uploads/{uploadId}/... pathnames", () => {
      expect(parseDocUploadBlobPathname(`docs/${DOC_ID}/uploads/${UPLOAD_ID}/2025-01-01T00-00-00-000Z-file.pdf`)).toEqual({
        docId: DOC_ID,
        uploadId: UPLOAD_ID,
      });
      expect(parseDocUploadBlobPathname(`docs/${DOC_ID}/uploads/${UPLOAD_ID}/pages/p0001/image.jpg`)).toEqual({
        docId: DOC_ID,
        uploadId: UPLOAD_ID,
      });
    });

    it("rejects malformed pathnames", () => {
      expect(parseDocUploadBlobPathname(`docs/${DOC_ID}/uploads/${UPLOAD_ID}`)).toBeNull();
      expect(parseDocUploadBlobPathname(`docs/${DOC_ID}/uploads/${UPLOAD_ID}/`)).toBeNull();
      expect(parseDocUploadBlobPathname(`docs/${DOC_ID}/other/${UPLOAD_ID}/x.pdf`)).toBeNull();
      expect(parseDocUploadBlobPathname(`docs/not-an-id/uploads/${UPLOAD_ID}/x.pdf`)).toBeNull();
      expect(parseDocUploadBlobPathname(`docs/${DOC_ID}/uploads/${UPLOAD_ID}/../x.pdf`)).toBeNull();
      expect(parseDocUploadBlobPathname(`org-avatars/${ORG_ID}/x.png`)).toBeNull();
      expect(parseDocUploadBlobPathname("client-tests/x.png")).toBeNull();
    });
  });

  describe("parseOrgAvatarBlobPathname", () => {
    it("parses org-avatars/{orgId}/... and rejects others", () => {
      expect(parseOrgAvatarBlobPathname(`org-avatars/${ORG_ID}/ts-avatar.png`)).toEqual({ orgId: ORG_ID });
      expect(parseOrgAvatarBlobPathname(`org-avatars/${ORG_ID}`)).toBeNull();
      expect(parseOrgAvatarBlobPathname("org-avatars/bad/x.png")).toBeNull();
      expect(parseOrgAvatarBlobPathname(`docs/${DOC_ID}/uploads/${UPLOAD_ID}/x.pdf`)).toBeNull();
    });
  });

  describe("blob store host + upload URL validation", () => {
    beforeEach(() => {
      vi.stubEnv("BLOB_BASE_URL", "https://abc123.public.blob.vercel-storage.com");
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("derives the store host from BLOB_BASE_URL", () => {
      expect(getBlobStoreHost()).toBe("abc123.public.blob.vercel-storage.com");
      expect(isBlobStoreHost("abc123.public.blob.vercel-storage.com")).toBe(true);
      expect(isBlobStoreHost("ABC123.public.blob.vercel-storage.com")).toBe(true);
      expect(isBlobStoreHost("other.public.blob.vercel-storage.com")).toBe(false);
      expect(isBlobStoreHost("evil.example.com")).toBe(false);
    });

    it("derives the store host from the BLOB_READ_WRITE_TOKEN store id when BLOB_BASE_URL is unset", () => {
      vi.stubEnv("BLOB_BASE_URL", "");
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_StOrE9x_s3cr3tpart");
      expect(getBlobStoreHost()).toBe("store9x.public.blob.vercel-storage.com");
      expect(isBlobStoreHost("store9x.public.blob.vercel-storage.com")).toBe(true);
      expect(isBlobStoreHost("other.public.blob.vercel-storage.com")).toBe(false);
      // Malformed tokens never yield a host.
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "not-a-blob-token");
      expect(getBlobStoreHost()).toBeNull();
    });

    it("falls back to the Vercel Blob host pattern only outside production", () => {
      vi.stubEnv("BLOB_BASE_URL", "");
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
      vi.stubEnv("NODE_ENV", "test");
      expect(getBlobStoreHost()).toBeNull();
      expect(isBlobStoreHost("whatever.public.blob.vercel-storage.com")).toBe(true);
      expect(isBlobStoreHost("evil.example.com")).toBe(false);
    });

    it("fails closed in production when the store cannot be identified", () => {
      vi.stubEnv("BLOB_BASE_URL", "");
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
      vi.stubEnv("NODE_ENV", "production");
      expect(getBlobStoreHost()).toBeNull();
      expect(isBlobStoreHost("whatever.public.blob.vercel-storage.com")).toBe(false);
      expect(
        isBlobUrlForUpload(
          `https://whatever.public.blob.vercel-storage.com/docs/${DOC_ID}/uploads/${UPLOAD_ID}/f.pdf`,
          { docId: DOC_ID, uploadId: UPLOAD_ID },
        ),
      ).toBe(false);
    });

    it("accepts blob URLs under the upload's own folder on the store host only", () => {
      const scope = { docId: DOC_ID, uploadId: UPLOAD_ID };
      expect(
        isBlobUrlForUpload(`https://abc123.public.blob.vercel-storage.com/docs/${DOC_ID}/uploads/${UPLOAD_ID}/f.pdf`, scope),
      ).toBe(true);
      expect(
        isBlobUrlForUpload(`https://abc123.public.blob.vercel-storage.com/docs/${DOC_ID}/uploads/${UPLOAD_ID}/preview.png`, scope),
      ).toBe(true);
      // Wrong host
      expect(isBlobUrlForUpload(`https://evil.example.com/docs/${DOC_ID}/uploads/${UPLOAD_ID}/f.pdf`, scope)).toBe(false);
      // Wrong scheme
      expect(
        isBlobUrlForUpload(`http://abc123.public.blob.vercel-storage.com/docs/${DOC_ID}/uploads/${UPLOAD_ID}/f.pdf`, scope),
      ).toBe(false);
      // Another upload's folder
      expect(
        isBlobUrlForUpload(`https://abc123.public.blob.vercel-storage.com/docs/${DOC_ID}/uploads/${ORG_ID}/f.pdf`, scope),
      ).toBe(false);
      // Garbage
      expect(isBlobUrlForUpload("not a url", scope)).toBe(false);
    });

    it("validates blobPathname against the upload folder", () => {
      const scope = { docId: DOC_ID, uploadId: UPLOAD_ID };
      expect(isBlobPathnameForUpload(`docs/${DOC_ID}/uploads/${UPLOAD_ID}/f.pdf`, scope)).toBe(true);
      expect(isBlobPathnameForUpload(`/docs/${DOC_ID}/uploads/${UPLOAD_ID}/f.pdf`, scope)).toBe(true);
      expect(isBlobPathnameForUpload(`docs/${ORG_ID}/uploads/${UPLOAD_ID}/f.pdf`, scope)).toBe(false);
      expect(isBlobPathnameForUpload(`docs/${DOC_ID}/uploads/${UPLOAD_ID}/%2e%2e/f.pdf`, scope)).toBe(false);
    });
  });
});
