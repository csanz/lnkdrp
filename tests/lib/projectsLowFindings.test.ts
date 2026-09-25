/**
 * The pure pieces behind the "Projects / notifications" Low findings of the 2026-09-23 review:
 * the anonymous-visit prefix, the upload path's role gate, the docCount definition, the tag docs
 * sort tiebreak, and the one default for `viewEmailMode`.
 */
import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import { projectDocCountFilter } from "@/lib/projects/docCountFilter";
import { botIdHashPrefixFilter, requestUploadPathFor } from "@/lib/projects/requestSettings";
import { TAG_DOCS_SORT } from "@/lib/tags/service";
import { DEFAULT_VIEW_EMAIL_MODE, normalizeViewEmailMode } from "@/lib/notifications/viewNotifications";

const SHA256 = "a".repeat(64);

describe("botIdHashPrefixFilter", () => {
  it("anchors a hex digest as a prefix, lower-cased", () => {
    expect(botIdHashPrefixFilter(SHA256.toUpperCase())).toEqual({ botIdHash: { $regex: `^${SHA256}` } });
  });

  it("refuses anything that is not a hex digest instead of matching everything", () => {
    expect(botIdHashPrefixFilter("not-a-hash")).toBeNull();
    expect(botIdHashPrefixFilter("")).toBeNull();
    expect(botIdHashPrefixFilter("abc")).toBeNull();
    // The old code stripped non-hex characters; this would have become "^" and matched every row.
    expect(botIdHashPrefixFilter("../../")).toBeNull();
    expect(botIdHashPrefixFilter(`${SHA256}.`)).toBeNull();
  });
});

describe("requestUploadPathFor", () => {
  it("hands the upload path to a seat that may upload", () => {
    expect(requestUploadPathFor({ token: "tok en", mayUpload: true })).toBe("/request/tok%20en");
  });

  it("gives a viewer seat nothing, and nothing when there is no token", () => {
    expect(requestUploadPathFor({ token: "token", mayUpload: false })).toBeNull();
    expect(requestUploadPathFor({ token: "", mayUpload: true })).toBeNull();
    expect(requestUploadPathFor({ token: null, mayUpload: true })).toBeNull();
  });
});

describe("projectDocCountFilter", () => {
  it("counts live, unarchived documents in the project by any membership field, in its workspace", () => {
    const orgId = new Types.ObjectId();
    const projectId = new Types.ObjectId();
    expect(projectDocCountFilter(orgId, projectId)).toEqual({
      orgId,
      isDeleted: { $ne: true },
      isArchived: { $ne: true },
      $or: [{ primaryProjectId: projectId }, { projectId }, { projectIds: projectId }],
    });
  });
});

describe("TAG_DOCS_SORT", () => {
  it("breaks updatedDate ties on _id so pages never repeat or skip a row", () => {
    expect(Object.keys(TAG_DOCS_SORT)).toEqual(["updatedDate", "_id"]);
    expect(TAG_DOCS_SORT._id).toBe(-1);
  });
});

describe("viewEmailMode default", () => {
  it("a missing value means immediate, in the sender and the off page alike", () => {
    expect(DEFAULT_VIEW_EMAIL_MODE).toBe("immediate");
    expect(normalizeViewEmailMode(undefined)).toBe(DEFAULT_VIEW_EMAIL_MODE);
    expect(normalizeViewEmailMode("daily")).toBe("daily");
    expect(normalizeViewEmailMode("off")).toBe("off");
  });
});
