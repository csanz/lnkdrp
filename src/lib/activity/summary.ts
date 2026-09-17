/**
 * What was DONE in this workspace over a window — the numbers behind the `/activity` header.
 *
 * Pure (no Mongo, no server imports): shared by `GET /api/activity/summary`, which counts in Mongo
 * and folds the grouped counts through here, and by the page that renders the result.
 *
 * The rule this file exists to hold: the header answers "what happened here", never "how did the
 * document perform". Views, opens and downloads are the metrics page's job and are excluded on
 * purpose — see `ACTIVITY_WORK_TYPES` below.
 */
import { ACTIVITY_FILTERS } from "@/lib/activity/labels";

/** One count in the header strip: a bucket id, its label, and the event types that feed it. */
export type ActivitySummaryBucket = {
  id: ActivitySummaryCountKey;
  label: string;
  types: readonly string[];
};

export type ActivitySummaryCountKey =
  | "docsAdded"
  | "docsReplaced"
  | "linksCreated"
  | "docsRemoved"
  | "projectsCreated";

/**
 * The counts the header shows, in display order.
 *
 * `doc.created` — not `upload.completed` — is what "a new document arrived" means here. Every path
 * that brings a document into the workspace opens with `POST /api/docs` (the browser's upload flow
 * and the MCP `share_pdf` tool alike), so `doc.created` fires exactly once per document. The two
 * candidates around it do not: `upload.completed` fires again for every replacement (a v3 upload is
 * still an upload), and `doc.imported_url` is the same arrival seen from the agent's side, so
 * counting either would inflate the number and double-count agent uploads.
 *
 * Archived and deleted are one count: to an owner both mean "that document is no longer live", and
 * splitting them across two tiles would spend half the strip on the rarest thing on the page.
 */
export const ACTIVITY_SUMMARY_BUCKETS: readonly ActivitySummaryBucket[] = [
  { id: "docsAdded", label: "Documents added", types: ["doc.created"] },
  { id: "docsReplaced", label: "Replaced", types: ["doc.replaced"] },
  { id: "linksCreated", label: "Links created", types: ["share_link.created"] },
  { id: "docsRemoved", label: "Archived or deleted", types: ["doc.archived", "doc.deleted"] },
  { id: "projectsCreated", label: "Projects created", types: ["project.created"] },
] as const;

/**
 * Types that are recorded activity but are not work done in this workspace, so neither the counts
 * nor the donut may include them.
 *
 * - the `views` filter group (`share.viewed`, `share.downloaded`): a recipient reading, which is
 *   performance and belongs to `/metrics`;
 * - `download_request.created` and `request.upload_received`: also a recipient, not a member;
 * - `doc.processed`: the pipeline finishing, not a person acting;
 * - `upload.completed` and `doc.imported_url`: the same document arrival that `doc.created` already
 *   counts, seen from the file and agent sides (see `ACTIVITY_SUMMARY_BUCKETS`);
 * - `share_link.password_revealed`: a read, not a change.
 *
 * `plan.*`, `credits.*`, `summary.generated` and `agent.*` are outside the filter vocabulary below
 * and so never enter the set in the first place.
 */
const NOT_WORK: ReadonlySet<string> = new Set<string>([
  ...(ACTIVITY_FILTERS.find((f) => f.id === "views")?.types ?? []),
  "download_request.created",
  "request.upload_received",
  "doc.processed",
  "upload.completed",
  "doc.imported_url",
  "share_link.password_revealed",
]);

/**
 * Every event type that counts as "someone did something here", derived from the page's own filter
 * vocabulary (`ACTIVITY_FILTERS`) minus `NOT_WORK`, so a type added to a filter group joins the
 * donut without a second list to remember.
 *
 * This is the denominator of the donut: its total is workspace actions in the window.
 */
export const ACTIVITY_WORK_TYPES: readonly string[] = Array.from(
  new Set(
    ACTIVITY_FILTERS.filter((f) => f.id !== "all")
      .flatMap((f) => f.types as readonly string[])
      .filter((t) => !NOT_WORK.has(t)),
  ),
).sort();

/** Bucket id a type feeds, or null when the type is counted in the donut but has no tile. */
export function bucketForType(type: string): ActivitySummaryCountKey | null {
  for (const b of ACTIVITY_SUMMARY_BUCKETS) {
    if (b.types.includes(type)) return b.id;
  }
  return null;
}

/** All counts at zero — the shape the header renders against before anything has happened. */
export function emptyCounts(): Record<ActivitySummaryCountKey, number> {
  return { docsAdded: 0, docsReplaced: 0, linksCreated: 0, docsRemoved: 0, projectsCreated: 0 };
}

/** One `{ type, client, count }` group as Mongo returns it (client is null for a browser action). */
export type ActivityGroupRow = { type: string; client: string | null; label?: string | null; count: number };

/** Who a donut slice stands for: the people in the app, one agent client, or the folded tail. */
export type ActorSliceKind = "people" | "agent" | "other";

export type ActorSlice = {
  /** Stable key: `people`, `agent:<client>`, or `agents:other`. */
  key: string;
  kind: ActorSliceKind;
  /** Agent client id (`claude-code`) for an agent slice, else null. */
  client: string | null;
  label: string;
  count: number;
};

export type ActivitySummary = {
  counts: Record<ActivitySummaryCountKey, number>;
  /** Work actions in the window, split by who did them. `total` is the sum of every slice. */
  actors: { total: number; people: number; agents: number; slices: ActorSlice[] };
};

/**
 * How many agent clients get a slice of their own before the tail folds.
 *
 * Three hues is the all-pairs ceiling for a form a reader compares slice-to-slice, and one of the
 * three is spent on the people slice — so two named agents, then a grey tail. A tail holding a
 * single client still names it (folding one client into "Other agents" would hide a name for
 * nothing); two or more read as "Other agents".
 */
export const MAX_NAMED_AGENT_SLICES = 2;

/** Sort agents by volume, then by label, so the order never wobbles between two equal counts. */
function byCountThenLabel(a: { count: number; label: string }, b: { count: number; label: string }): number {
  return b.count - a.count || a.label.localeCompare(b.label);
}

/**
 * Group work actions by who did them.
 *
 * A row with an `agent.client` was an MCP/API call and is credited to that client; a row without one
 * was done by a person in the app (they are one slice, because the question the donut answers is
 * "agents or us", not "which of us"). Zero-count sides are dropped rather than drawn as empty
 * slices, so a workspace with no agents yields a single slice and the caller can skip the circle.
 */
export function groupActorSlices(
  rows: readonly ActivityGroupRow[],
  opts: { maxNamedAgents?: number } = {},
): ActivitySummary["actors"] {
  const maxNamed = Math.max(1, opts.maxNamedAgents ?? MAX_NAMED_AGENT_SLICES);
  let people = 0;
  const byClient = new Map<string, { client: string; label: string; count: number }>();

  for (const row of rows) {
    const count = Number.isFinite(row.count) ? Math.max(0, Math.trunc(row.count)) : 0;
    if (!count) continue;
    const client = typeof row.client === "string" ? row.client.trim().toLowerCase() : "";
    if (!client) {
      people += count;
      continue;
    }
    const prev = byClient.get(client);
    const label = (row.label ?? "").trim() || prev?.label || client;
    byClient.set(client, { client, label, count: (prev?.count ?? 0) + count });
  }

  const agentsSorted = Array.from(byClient.values()).sort(byCountThenLabel);
  const named = agentsSorted.slice(0, maxNamed);
  const tail = agentsSorted.slice(maxNamed);

  const slices: ActorSlice[] = [];
  if (people > 0) slices.push({ key: "people", kind: "people", client: null, label: "People in the app", count: people });
  for (const a of named) slices.push({ key: `agent:${a.client}`, kind: "agent", client: a.client, label: a.label, count: a.count });
  if (tail.length === 1) {
    const only = tail[0]!;
    slices.push({ key: `agent:${only.client}`, kind: "agent", client: only.client, label: only.label, count: only.count });
  } else if (tail.length > 1) {
    const count = tail.reduce((sum, a) => sum + a.count, 0);
    slices.push({ key: "agents:other", kind: "other", client: null, label: `${tail.length} other agents`, count });
  }

  const agents = slices.filter((s) => s.kind !== "people").reduce((sum, s) => sum + s.count, 0);
  return { total: people + agents, people, agents, slices };
}

/**
 * Fold the grouped `{ type, client, count }` rows into the header's counts and donut slices.
 *
 * Rows of a type outside `ACTIVITY_WORK_TYPES` are ignored here as well as in the query, so a stale
 * client or a wider query can never smuggle a view count into either number.
 */
export function summarizeActivityRows(rows: readonly ActivityGroupRow[]): ActivitySummary {
  const work = rows.filter((r) => ACTIVITY_WORK_TYPES.includes(r.type));
  const counts = emptyCounts();
  for (const row of work) {
    const bucket = bucketForType(row.type);
    if (!bucket) continue;
    const count = Number.isFinite(row.count) ? Math.max(0, Math.trunc(row.count)) : 0;
    counts[bucket] += count;
  }
  return { counts, actors: groupActorSlices(work) };
}

/**
 * One day of work in the window: the total, who did it, and each counted kind of work.
 *
 * The chart draws one line per bucket, so every bucket is a key on the point even on a day when it
 * is zero - a missing key would break the line rather than flatten it.
 */
export type ActivityDayPoint = { day: string; total: number; people: number; agents: number } & Record<ActivitySummaryCountKey, number>;

/** A row of the per-day aggregation: a day key, the event type, whether an agent did it, how many. */
export type ActivityDayRow = { day: string; type: string; agent: boolean; count: number };

/**
 * Fill the window day by day, oldest first.
 *
 * Mongo only returns days that had activity; a chart needs every day or the line lies about the
 * gaps. `since` is the first day shown and `days` the width, both as the endpoint computed them.
 */
export function buildActivitySeries(rows: readonly ActivityDayRow[], input: { since: Date; days: number }): ActivityDayPoint[] {
  const blank = () => ({ people: 0, agents: 0, ...emptyCounts() });
  const byDay = new Map<string, ReturnType<typeof blank>>();
  for (const row of rows) {
    if (!row?.day) continue;
    const count = Number.isFinite(row.count) ? Math.max(0, Math.trunc(row.count)) : 0;
    const cur = byDay.get(row.day) ?? blank();
    if (row.agent) cur.agents += count;
    else cur.people += count;
    const bucket = bucketForType(row.type);
    if (bucket) cur[bucket] += count;
    byDay.set(row.day, cur);
  }
  const out: ActivityDayPoint[] = [];
  const start = new Date(Date.UTC(input.since.getUTCFullYear(), input.since.getUTCMonth(), input.since.getUTCDate()));
  for (let i = 0; i < input.days; i++) {
    const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    const day = d.toISOString().slice(0, 10);
    const hit = byDay.get(day) ?? blank();
    const { people, agents, ...counts } = hit;
    out.push({ day, people, agents, total: people + agents, ...counts });
  }
  return out;
}
