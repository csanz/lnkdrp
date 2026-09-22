/**
 * A 404 from a link route has to name the id that was actually wrong.
 *
 * `lnkdrp_verify_share_password` and `lnkdrp_get_share_link_password` are the only tools that call
 * a `/links/:linkId` route before reading the document, so they are the only ones that can hand
 * `mapApiError` a 404 raised by the document gate. The path test matched first and answered "No
 * such link on this document" - byte-identical to the answer for a real document and a dead link -
 * and the agent went hunting for a link that was fine.
 */
import { describe, expect, it } from "vitest";

import { mapApiError } from "../../mcp/src/errors";

const VERIFY_PATH = "/api/docs/000000000000000000000000/links/6ab2072cd7e47b3f56a136bf/password/verify";
const REVEAL_PATH = "/api/docs/000000000000000000000000/links/6ab2072cd7e47b3f56a136bf/password";

function map(path: string, body: unknown, method = "POST") {
  return mapApiError({ status: 404, body, method, path, siteUrl: "https://lnkdrp.com" });
}

describe("mapApiError: which id a link-route 404 is about", () => {
  it("blames the document when the document gate is what refused", () => {
    // accessDocForLinks answers exactly this for a docId the workspace cannot see, before the
    // route has looked at the linkId at all.
    const err = map(VERIFY_PATH, { error: "Not found" });
    expect(err.code).toBe("not_found");
    expect(err.message).toBe("No such document in this workspace.");
  });

  it("blames the document on the reveal route too, which skips the doc read the same way", () => {
    expect(map(REVEAL_PATH, { error: "Not found" }, "GET").message).toBe("No such document in this workspace.");
  });

  it("still blames the link when the link is the thing that is missing", () => {
    const err = map(VERIFY_PATH, { error: "Link not found." });
    expect(err.code).toBe("not_found");
    expect(err.message).toContain("No such link on this document");
    expect(err.message).toContain("lnkdrp_find_share_link");
  });

  it("still blames the link for a deleted one, whose sentence names neither noun", () => {
    const body = { error: "That link was deleted, so its password no longer opens anything." };
    expect(map(VERIFY_PATH, body).message).toContain("No such link on this document");
  });

  it("keeps the path fallback for a link 404 that carries no body to read", () => {
    expect(map("/api/docs/6ab20688d7e47b3f56a11aa7/links/6ab2072cd7e47b3f56a136bf", {}, "PATCH").message).toContain(
      "No such link on this document",
    );
  });

  it("leaves the project link answer alone", () => {
    const err = map("/api/projects/6ab20722d7e47b3f56a13355/links/6ab2072cd7e47b3f56a136bf", { error: "Link not found." }, "PATCH");
    expect(err.message).toContain("No such link on this project");
  });
});
