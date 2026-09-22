/**
 * The guard on `npm run reset`.
 *
 * That command drops every collection. `MONGODB_URI` is one line in one file and the same variable
 * name in every environment, so what stands between a test reset and a destroyed production
 * database is this function — not care at the keyboard.
 *
 * Which makes the interesting cases the ones that *look* local: a replica-set URI whose first host
 * is localhost, an SRV record that resolves somewhere else, a password containing an `@`.
 */
import { describe, expect, test } from "vitest";

import { isLocalMongoTarget, mongoHosts } from "@/lib/db/localTarget";

/** No ambient NODE_ENV/VERCEL leaking in from the test runner. */
const DEV: NodeJS.ProcessEnv = { NODE_ENV: "development" } as NodeJS.ProcessEnv;

describe("pulling the hosts out", () => {
  test("the ordinary case", () => {
    expect(mongoHosts("mongodb://localhost:27017/lnkdrp_dev")).toEqual(["localhost"]);
  });

  test("every host in a replica set, not just the first", () => {
    expect(mongoHosts("mongodb://localhost:27017,db2.example.com:27017/x")).toEqual(["localhost", "db2.example.com"]);
  });

  test("credentials containing an @ do not split the host off early", () => {
    expect(mongoHosts("mongodb://user:p@ss@localhost:27017/x")).toEqual(["localhost"]);
  });

  test("options with no database path", () => {
    expect(mongoHosts("mongodb://localhost:27017?replicaSet=rs0")).toEqual(["localhost"]);
  });

  test("bracketed IPv6 keeps its brackets and loses its port", () => {
    expect(mongoHosts("mongodb://[::1]:27017/x")).toEqual(["[::1]"]);
  });
});

describe("what passes", () => {
  test("a database on this machine", () => {
    for (const uri of [
      "mongodb://localhost:27017/lnkdrp_dev",
      "mongodb://127.0.0.1:27017/lnkdrp_dev",
      "mongodb://[::1]:27017/lnkdrp_dev",
      "mongodb://localhost/lnkdrp_dev",
      "mongodb://user:pass@localhost:27017/lnkdrp_dev?authSource=admin",
    ]) {
      expect(isLocalMongoTarget(uri, DEV).local, uri).toBe(true);
    }
  });
});

describe("what does not", () => {
  test("a hosted cluster, however it is named", () => {
    // The scheme means "resolve this in DNS", so the name says nothing about where it lands.
    const out = isLocalMongoTarget("mongodb+srv://localhost/lnkdrp", DEV);

    expect(out.local).toBe(false);
    expect(out).toMatchObject({ reason: expect.stringContaining("hosted cluster") });
  });

  test("a replica set with one remote member, even when localhost comes first", () => {
    // The URI connects to the set, not to the first entry. Reading `hosts[0]` would drop the lot.
    const out = isLocalMongoTarget("mongodb://localhost:27017,cluster.example.com:27017/lnkdrp", DEV);

    expect(out.local).toBe(false);
    expect(out).toMatchObject({ reason: expect.stringContaining("cluster.example.com") });
  });

  test("an ordinary remote host", () => {
    expect(isLocalMongoTarget("mongodb://db.internal:27017/lnkdrp", DEV).local).toBe(false);
  });

  test("production, whatever the host says", () => {
    // Someone may have tunnelled a database to 127.0.0.1; a production process still has no
    // business dropping collections.
    const out = isLocalMongoTarget("mongodb://localhost:27017/lnkdrp_dev", {
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);

    expect(out.local).toBe(false);
    expect(out).toMatchObject({ reason: expect.stringContaining("production") });
  });

  test("a deployed environment, whatever the host says", () => {
    for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_URL"]) {
      const out = isLocalMongoTarget("mongodb://localhost:27017/x", {
        NODE_ENV: "development",
        [key]: "1",
      } as NodeJS.ProcessEnv);

      expect(out.local, key).toBe(false);
    }
  });

  test("nothing, or something that is not a connection string", () => {
    for (const uri of ["", "   ", "postgres://localhost/x", "localhost:27017", "http://localhost:27017"]) {
      expect(isLocalMongoTarget(uri, DEV).local, uri).toBe(false);
    }
  });
});
