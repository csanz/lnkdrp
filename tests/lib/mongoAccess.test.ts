import { describe, expect, test } from "vitest";

import {
  explainMongoAuthzError,
  isMongoAuthzError,
  judgeMongoAccess,
  mongoUriDatabase,
  mongoUriUser,
} from "@/lib/db/access";

const ATLAS = "mongodb+srv://app_user:s3cr%40t@cluster0.abc.mongodb.net/lnkdrp-dev?appName=x";

describe("mongoUriDatabase / mongoUriUser", () => {
  test("reads the path and the user from an Atlas URI, never the password", () => {
    expect(mongoUriDatabase(ATLAS)).toBe("lnkdrp-dev");
    expect(mongoUriUser(ATLAS)).toBe("app_user");
  });
  test("handles replica-set host lists, no path, and percent-encoding", () => {
    expect(mongoUriDatabase("mongodb://a:27017,b:27017/my%2Ddb?replicaSet=rs0")).toBe("my-db");
    expect(mongoUriDatabase("mongodb://localhost:27017")).toBe("");
    expect(mongoUriDatabase("mongodb://localhost:27017/")).toBe("");
    expect(mongoUriUser("mongodb://localhost:27017/db")).toBeNull();
    expect(mongoUriDatabase("not a uri")).toBe("");
  });
});

describe("isMongoAuthzError", () => {
  test("recognises code 13 by number, name, or message", () => {
    expect(isMongoAuthzError({ code: 13 })).toBe(true);
    expect(isMongoAuthzError({ codeName: "Unauthorized" })).toBe(true);
    expect(isMongoAuthzError(new Error('not authorized on x to execute command { find: "users" }'))).toBe(true);
    expect(isMongoAuthzError({ code: 18, codeName: "AuthenticationFailed" })).toBe(false);
    expect(isMongoAuthzError(null)).toBe(false);
  });
});

describe("judgeMongoAccess", () => {
  const authInfo = {
    authenticatedUsers: [{ user: "app_user", db: "admin" }],
    authenticatedUserRoles: [{ role: "readWrite", db: "lnkdrp_dev" }],
    authenticatedUserPrivileges: [
      { resource: { db: "lnkdrp_dev", collection: "" }, actions: ["find", "insert", "changeStream"] },
      { resource: { db: "lnkdrp_dev", collection: "system.js" }, actions: ["find"] },
    ],
  };

  test("names the hyphen/underscore slip and both ways to fix it", () => {
    const v = judgeMongoAccess("lnkdrp-dev", authInfo);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.grantedOn).toEqual(["lnkdrp_dev"]);
    expect(v.message).toContain('Mongo user "app_user" has no privileges on database "lnkdrp-dev"');
    expect(v.message).toContain("readWrite@lnkdrp_dev");
    expect(v.message).toContain('"lnkdrp_dev" differs from "lnkdrp-dev" only by hyphens/underscores/case');
    expect(v.message).toContain("change the database in MONGODB_URI");
    expect(v.message).toContain('grant the user a role on "lnkdrp-dev"');
  });

  test("passes when a privilege covers the database, all databases, or the cluster", () => {
    expect(judgeMongoAccess("lnkdrp_dev", authInfo).ok).toBe(true);
    expect(
      judgeMongoAccess("anything", {
        authenticatedUserPrivileges: [{ resource: { db: "", collection: "" }, actions: ["find"] }],
      }).ok,
    ).toBe(true);
    expect(
      judgeMongoAccess("anything", { authenticatedUserPrivileges: [{ resource: { cluster: true }, actions: ["x"] }] }).ok,
    ).toBe(true);
    expect(
      judgeMongoAccess("anything", { authenticatedUserPrivileges: [{ resource: { anyResource: true }, actions: ["x"] }] })
        .ok,
    ).toBe(true);
  });

  test("does not guess when the server reports nothing", () => {
    expect(judgeMongoAccess("lnkdrp-dev", null).ok).toBe(true);
    expect(judgeMongoAccess("lnkdrp-dev", { authenticatedUserPrivileges: [] }).ok).toBe(true);
    expect(judgeMongoAccess("", authInfo).ok).toBe(true);
  });

  test("a mismatch that is not a lookalike still says what is covered", () => {
    const v = judgeMongoAccess("lnkdrp-prod", authInfo);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.message).not.toContain("differs from");
    expect(v.message).toContain('cover: "lnkdrp_dev"');
  });
});

describe("explainMongoAuthzError", () => {
  const raw =
    'not authorized on lnkdrp-dev to execute command { find: "users", filter: { email: "c@example.com" }, projection: { _id: 1 }, lsid: { id: UUID("x") }, $db: "lnkdrp-dev" }';

  test("keeps the command and collection, drops the filter, names the user from the URI", () => {
    const s = explainMongoAuthzError(new Error(raw), { uri: ATLAS });
    expect(s).toContain('Mongo refused find on "users"');
    expect(s).toContain('Mongo user "app_user" is not authorized on database "lnkdrp-dev"');
    expect(s).toContain("hyphens vs underscores");
    expect(s).not.toContain("c@example.com");
    expect(s).not.toContain("s3cr");
  });

  test("still reads when the message has no parsable command", () => {
    const s = explainMongoAuthzError({ code: 13, message: "Unauthorized" }, { uri: ATLAS });
    expect(s).toContain('Mongo refused a command: Mongo user "app_user" is not authorized on database "lnkdrp-dev"');
    expect(explainMongoAuthzError("boom")).toContain("the Mongo user is not authorized on this database");
  });
});
