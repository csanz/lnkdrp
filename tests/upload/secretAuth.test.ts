/**
 * The upload secret is read-only once an upload has completed (code review 2026-09-23, H1).
 *
 * The three write surfaces (Blob token, PATCH, process) spread these fragments into their own
 * Mongo filters, so what is pinned here is the status set each one accepts. A `completed` upload
 * must appear in neither: that is the whole fix.
 */
import { describe, expect, it } from "vitest";

import {
  SECRET_PROCESSABLE_STATUSES,
  SECRET_WRITABLE_STATUSES,
  secretProcessableFilter,
  secretWritableFilter,
} from "../../src/lib/uploads/secretAuth";

describe("upload secret status gates", () => {
  it("a completed upload is writable by no secret-auth surface", () => {
    expect(SECRET_WRITABLE_STATUSES).not.toContain("completed");
    expect(SECRET_PROCESSABLE_STATUSES).not.toContain("completed");
  });

  it("bytes and metadata may land while the upload is still being uploaded", () => {
    expect([...SECRET_WRITABLE_STATUSES]).toEqual(["uploading", "uploaded"]);
    expect(secretWritableFilter()).toEqual({ status: { $in: ["uploading", "uploaded"] } });
  });

  it("processing may start, retry after a failure, or re-claim a stale run", () => {
    expect([...SECRET_PROCESSABLE_STATUSES].sort()).toEqual(["failed", "processing", "uploaded"]);
    expect(secretProcessableFilter().status.$in).not.toContain("uploading");
  });
});
