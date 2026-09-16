/**
 * One share-password length rule across every surface that enforces it (mt_eqYXr8Z5Pn).
 *
 * The 8-character minimum was hardcoded in four places — the link service, the doc-level
 * share-password route, the edit modal, and the MCP zod schemas — which is how they drifted and
 * how an agent ended up substituting its own longer password for the one a human gave it. These
 * tests pin the rule itself and check that the MCP schemas still agree with it.
 */
import { describe, expect, test } from "vitest";

const { SHARE_PASSWORD_MIN, SHARE_PASSWORD_MAX } = await import("@/lib/share/passwordPolicy");
const { createShareLinkInputShape, updateShareLinkInputShape } = await import("../../mcp/src/tools/shareLinks");
const { sharePdfInputShape } = await import("../../mcp/src/tools/sharePdf");
const { setShareAccessInputShape } = await import("../../mcp/src/tools/setShareAccess");

const SCHEMAS = [
  ["lnkdrp_create_share_link", createShareLinkInputShape.password],
  ["lnkdrp_update_share_link", updateShareLinkInputShape.password],
  ["lnkdrp_share_pdf", sharePdfInputShape.password],
  ["lnkdrp_set_share_access", setShareAccessInputShape.password],
] as const;

describe("share password policy", () => {
  test("the minimum is 1, so a human's short password is never refused", () => {
    expect(SHARE_PASSWORD_MIN).toBe(1);
    expect(SHARE_PASSWORD_MAX).toBe(128);
  });

  test.each(SCHEMAS)("%s accepts a one-character password", (_name, schema) => {
    expect(schema.safeParse("j").success).toBe(true);
  });

  test.each(SCHEMAS)("%s still refuses an empty string and an over-long one", (_name, schema) => {
    expect(schema.safeParse("").success).toBe(false);
    expect(schema.safeParse("x".repeat(SHARE_PASSWORD_MAX + 1)).success).toBe(false);
    expect(schema.safeParse("x".repeat(SHARE_PASSWORD_MAX)).success).toBe(true);
  });

  test("the schemas that can clear a password still accept null", () => {
    expect(createShareLinkInputShape.password.safeParse(null).success).toBe(true);
    expect(updateShareLinkInputShape.password.safeParse(null).success).toBe(true);
    expect(setShareAccessInputShape.password.safeParse(null).success).toBe(true);
  });
});
