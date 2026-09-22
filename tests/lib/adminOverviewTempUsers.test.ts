/**
 * The admin home's headline tiles (`GET /api/admin/overview`).
 *
 * `resolveActor` mints a temp user, a personal org and a membership for every anonymous visitor
 * who touches an upload, and nothing ever sweeps them. The overview route counted those rows as
 * Accounts, as Signups (tile, trend percentage and chart series) and as Workspaces, so the page an
 * operator reads to judge growth reported 42 accounts and 45 workspaces for a deployment with two
 * accounts, and the signups line was a plot of anonymous traffic.
 *
 * These run the real handler against an in-memory Mongo stub: a couple of real accounts among a
 * crowd of temp rows, each with the personal org its creation mints, plus one team org.
 */
import { describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

type Row = Record<string, unknown>;

const USERS: Row[] = [];
const ORGS: Row[] = [];

/**
 * Candidate values at a dotted path, the way Mongo reads one.
 *
 * An array is kept whole and resolved by the NEXT segment, because the two readings differ and the
 * route needs both: a numeric segment indexes the array (`owner.0`, "the lookup found somebody"),
 * and a field name applies to every element (`owner.isTemp`). Flattening on the way in collapsed
 * them into one, so `owner.0` looked up field "0" on an element and always answered undefined.
 * A missing field still yields `undefined` rather than nothing, so `{ field: null }` goes on
 * matching a document that does not have it, as Mongo does.
 */
function resolve(doc: unknown, path: string): unknown[] {
  let current: unknown[] = [doc];
  for (const part of path.split(".")) {
    const next: unknown[] = [];
    for (const node of current) {
      if (node === null || node === undefined) continue;
      if (Array.isArray(node)) {
        if (/^\d+$/.test(part)) {
          const at = node[Number(part)];
          if (at !== undefined) next.push(at);
        } else {
          for (const el of node) {
            if (el !== null && el !== undefined) next.push((el as Row)[part]);
          }
        }
        continue;
      }
      next.push((node as Row)[part]);
    }
    current = next;
  }
  return current;
}

/**
 * Enough of a Mongo matcher for this route: equality (null matches missing), `$ne`, `$gte`, `$lt`,
 * `$exists`, and the `$or` / `$and` the workspace count needs after its `$lookup`.
 *
 * The logical operators are here because the org count cannot be expressed without them: a team
 * org has no `personalForUserId` at all, while a personal one counts only when its owner row
 * exists and is not a temp. Without them this stub silently matched nothing and the route's real
 * query read as broken.
 */
function matches(doc: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") return (cond as Row[]).some((sub) => matches(doc, sub));
    if (key === "$and") return (cond as Row[]).every((sub) => matches(doc, sub));
    const values = resolve(doc, key);
    const defined = values.filter((v) => v !== undefined);
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      return Object.entries(cond as Row).every(([op, operand]) => {
        if (op === "$ne") return !values.some((v) => same(v, operand));
        if (op === "$gte") return defined.some((v) => Number(v) >= Number(operand));
        if (op === "$lt") return defined.some((v) => Number(v) < Number(operand));
        // `owner.0: { $exists: true }` is how the route asks "the lookup found somebody".
        if (op === "$exists") return operand ? defined.length > 0 : defined.length === 0;
        throw new Error(`stub does not implement ${op}`);
      });
    }
    return values.some((v) => same(v, cond));
  });
}

function same(a: unknown, b: unknown): boolean {
  if (b === null) return a === null || a === undefined;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return String(a) === String(b);
}

/** `$match`, `$lookup`, `$group` by UTC day, `$sort`, `$count`. Nothing else is used here. */
function runPipeline(rows: Row[], pipeline: Row[]): Row[] {
  let out = rows.map((r) => ({ ...r }));
  for (const stage of pipeline) {
    if (stage.$match) {
      out = out.filter((r) => matches(r, stage.$match as Row));
    } else if (stage.$lookup) {
      const spec = stage.$lookup as { from: string; localField: string; foreignField: string; as: string };
      const source = spec.from === "users" ? USERS : ORGS;
      out = out.map((r) => ({
        ...r,
        [spec.as]: source.filter((s) => r[spec.localField] !== undefined && same(s[spec.foreignField], r[spec.localField])),
      }));
    } else if (stage.$group) {
      const by = new Map<string, number>();
      const field = String(((stage.$group as Row)._id as Row).$dateToString ? ((((stage.$group as Row)._id as Row).$dateToString as Row).date as string) : "").slice(1);
      for (const r of out) {
        const day = new Date(r[field] as Date).toISOString().slice(0, 10);
        by.set(day, (by.get(day) ?? 0) + 1);
      }
      out = [...by.entries()].map(([_id, n]) => ({ _id, n }));
    } else if (stage.$sort) {
      out = out.sort((a, b) => String(a._id).localeCompare(String(b._id)));
    } else if (stage.$count) {
      out = out.length ? [{ [String(stage.$count)]: out.length }] : [];
    } else {
      throw new Error(`stub does not implement ${Object.keys(stage).join(",")}`);
    }
  }
  return out;
}

function collection(rows: Row[], name: string) {
  return {
    collection: { name },
    countDocuments: async (filter: Row = {}) => rows.filter((r) => matches(r, filter)).length,
    aggregate: async (pipeline: Row[]) => runPipeline(rows, pipeline),
  };
}

/** A collection this test does not care about: nothing in it, whatever is asked. */
const empty = {
  countDocuments: async () => 0,
  aggregate: async () => [],
  find: () => ({ select: () => ({ limit: () => ({ lean: async () => [] }) }) }),
};

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/gating/requireAdmin", () => ({
  requireAdmin: vi.fn(async () => ({ ok: true, userId: "staff", email: "staff@lnkdrp.test" })),
}));
vi.mock("@/lib/models/User", () => ({ UserModel: collection(USERS, "users") }));
vi.mock("@/lib/models/Org", () => ({ OrgModel: collection(ORGS, "orgs") }));
vi.mock("@/lib/models/Doc", () => ({ DocModel: empty }));
vi.mock("@/lib/models/ShareView", () => ({ ShareViewModel: empty }));
vi.mock("@/lib/models/ShareLink", () => ({ ShareLinkModel: empty }));
vi.mock("@/lib/models/AiRun", () => ({ AiRunModel: empty }));
vi.mock("@/lib/models/CreditLedger", () => ({ CreditLedgerModel: empty }));
vi.mock("@/lib/models/CronHealth", () => ({ CronHealthModel: empty }));

const { GET } = await import("@/app/api/admin/overview/route");

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

/** A user row plus the personal org that `resolveActor` / signup mints beside it. */
function seedUser(opts: { temp: boolean; ageDays: number }) {
  const _id = new Types.ObjectId();
  USERS.push({
    _id,
    createdAt: new Date(now - opts.ageDays * DAY),
    isActive: true,
    ...(opts.temp ? { isTemp: true, role: "temp" } : { isTemp: false, role: "user", email: `u${USERS.length}@lnkdrp.test` }),
  });
  ORGS.push({ _id: new Types.ObjectId(), type: "personal", name: "Personal", personalForUserId: _id, isDeleted: false });
}

// Two real accounts, one signed up inside the 30-day window and one before it; one real signup in
// the previous window so the trend has something to compare against; and forty anonymous sessions.
seedUser({ temp: false, ageDays: 3 });
seedUser({ temp: false, ageDays: 400 });
seedUser({ temp: false, ageDays: 40 });
for (let i = 0; i < 40; i += 1) seedUser({ temp: true, ageDays: 2 });
seedUser({ temp: true, ageDays: 40 });
// One real team workspace, which has no `personalForUserId` at all.
ORGS.push({ _id: new Types.ObjectId(), type: "team", name: "Northwind", slug: "northwind", isDeleted: false });

async function overview() {
  const res = await GET(new Request("http://localhost:3001/api/admin/overview?days=30", { headers: { host: "localhost:3001" } }));
  return (await res.json()) as {
    totals: { users: number; orgs: number; newUsers: number };
    trend: { users: { current: number; previous: number } };
    series: Array<{ day: string; users: number }>;
  };
}

describe("admin overview counts accounts, not anonymous sessions", () => {
  test("Accounts, Signups and Workspaces ignore temp rows and the orgs minted with them", async () => {
    const body = await overview();

    // 3 real accounts among 41 temp rows, and 1 of them signed up in the last 30 days.
    expect(body.totals.users).toBe(3);
    expect(body.totals.newUsers).toBe(1);
    expect(body.trend.users.current).toBe(1);
    expect(body.trend.users.previous).toBe(1);

    // 3 personal workspaces plus the team one; the 41 temp personal orgs are not workspaces.
    expect(body.totals.orgs).toBe(4);
  });

  test("the signups series matches the tile above it", async () => {
    const body = await overview();
    expect(body.series.reduce((n, d) => n + d.users, 0)).toBe(1);
  });
});
