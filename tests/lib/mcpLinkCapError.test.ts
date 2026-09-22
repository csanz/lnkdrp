/**
 * The 50-links-per-document / per-project cap must reach an agent as its own fault.
 *
 * `mapApiError` had no `case 409`, so the cap came back as `upstream`, the code this module
 * reserves for "our side broke, retrying the same call is reasonable". Both halves are wrong at a
 * cap: the call can never succeed, and deleting or reusing a link is exactly what fixes it. These
 * tests pin the documented contract (docs/MCP.md: `validation` carrying `code: "too_many_links"`)
 * and the 409s that really are ours, which must stay `upstream`.
 */
import { describe, expect, it } from "vitest";

import { mapApiError } from "../../mcp/src/errors";

const DOC_ID = "6ab20688d7e47b3f56a11aa7";

/** A non-2xx REST response as the API actually serialises it (`linkErrorResponse`). */
function map(status: number, path: string, body: unknown) {
  return mapApiError({ status, path, method: "POST", body, siteUrl: "https://lnkdrp.com" });
}

describe("mapApiError: link caps", () => {
  it("calls the document link cap validation, not upstream, and keeps the code machine-readable", () => {
    const err = map(409, `/api/docs/${DOC_ID}/links`, {
      error: "A document can have at most 50 links.",
      code: "too_many_links",
    });

    expect(err.code).toBe("validation");
    expect(err.status).toBe(409);
    expect(err.details).toMatchObject({ code: "too_many_links" });
    // The ceiling alone is not actionable; the way under it has to be in the message.
    expect(err.message).toContain("A document can have at most 50 links.");
    expect(err.message).toContain("lnkdrp_delete_share_link");
    expect(err.message).toContain("lnkdrp_list_share_links");
  });

  it("names the project link tools when the cap is a project's", () => {
    const err = map(409, "/api/projects/northwind-series-a/links", {
      error: "A project can have at most 50 links.",
      code: "too_many_links",
    });

    expect(err.code).toBe("validation");
    expect(err.details).toMatchObject({ code: "too_many_links" });
    expect(err.message).toContain("A project can have at most 50 links.");
    expect(err.message).toContain("lnkdrp_delete_project_link");
    // Telling an agent at the project cap to make another project link is a loop.
    expect(err.message).not.toContain("lnkdrp_create_project_link");
  });

  it("leaves the 409s that are genuinely ours as upstream", () => {
    const retries = map(409, "/api/docs", { error: "Could not create doc", code: "DOC_CREATE_RETRY_EXHAUSTED" });
    expect(retries.code).toBe("upstream");
    expect(retries.status).toBe(409);

    // The replace_pdf/share_pdf retry loop keys on status 409 for this one; it must not be reclassified.
    const notReady = map(409, "/api/uploads/up_1/process", { error: "UPLOAD_NOT_READY", status: "uploading" });
    expect(notReady.code).toBe("upstream");
    expect(notReady.status).toBe(409);
  });
});
