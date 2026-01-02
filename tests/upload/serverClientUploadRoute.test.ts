import { describe, expect, it } from "vitest";

import {
  assertAllowedTestPathname,
  CLIENT_UPLOAD_MAX_SIZE_BYTES,
} from "../../src/lib/blob/serverClientUploadRoute";
import {
  DOC_BLOB_PREFIX,
  ORG_AVATAR_PREFIX,
  TEST_BLOB_PREFIX,
} from "../../src/lib/blob/clientUpload";

describe("serverClientUploadRoute", () => {
  it("assertAllowedTestPathname allows the known prefixes", () => {
    expect(() => assertAllowedTestPathname(`${TEST_BLOB_PREFIX}abc`)).not.toThrow();
    expect(() => assertAllowedTestPathname(`${DOC_BLOB_PREFIX}doc1/uploads/u1/x.pdf`)).not.toThrow();
    expect(() => assertAllowedTestPathname(`${ORG_AVATAR_PREFIX}org1/x.png`)).not.toThrow();
  });

  it("assertAllowedTestPathname rejects other prefixes", () => {
    expect(() => assertAllowedTestPathname("private/secret.txt")).toThrow(/Invalid pathname/i);
  });

  it("exposes a reasonable max size constant (sanity)", () => {
    expect(CLIENT_UPLOAD_MAX_SIZE_BYTES).toBeGreaterThan(1_000_000);
  });
});


