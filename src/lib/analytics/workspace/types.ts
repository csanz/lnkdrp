/**
 * The response contract of `GET /api/metrics/workspace` (docs/prds/lnkdrp-workspace-metrics.md).
 *
 * One endpoint returns the whole page, so this file is the single place the route and the UI agree
 * on what a number means. Two rules run through every type here:
 *
 * - **Same definitions as `/doc/:docId/metrics`.** Views, viewers, reading time and downloads are
 *   the document page's figures aggregated by `orgId` (recipients only, bounded by *last activity*
 *   in the window). A document's row on this page must equal its own metrics page for the same
 *   range; if they disagree, the document page is right and this one has a bug.
 * - **Free never carries identities.** `people.items` is `[]` on Free and no name or email string
 *   appears anywhere else in the payload — the identity aggregate is not even run
 *   (`src/lib/analytics/workspace/query.ts`).
 */

/** The three ranges the page offers. 30 days is the default. */
export type WorkspaceRangeKey = "7d" | "30d" | "90d";

/**
 * The three keys, their lengths and the default, kept here beside the type rather than in
 * `./range`: the page client reads them to build its segmented control, and `./range` reaches the
 * plan limits (and through them Mongoose), which must never follow an import into the browser.
 */
export const WORKSPACE_RANGE_KEYS: readonly WorkspaceRangeKey[] = ["7d", "30d", "90d"] as const;

/** The range the page opens on (PRD decision 3). */
export const WORKSPACE_DEFAULT_RANGE: WorkspaceRangeKey = "30d";

/** Days per key. `WorkspaceRange.days` is still the authority for what a response actually covers. */
export const WORKSPACE_RANGE_DAYS: Record<WorkspaceRangeKey, number> = { "7d": 7, "30d": 30, "90d": 90 };

/**
 * A headline figure with its comparison against the previous period of the same length.
 *
 * `previous` is `null` when the comparison is withheld rather than zero — a Free workspace may not
 * read past its analytics window, so it gets no previous period at all. `changePct` is `null`
 * whenever a percentage would be a lie: no previous period, or a previous period of zero (the UI
 * says "new", never "+∞%").
 */
export type WorkspaceMetricDelta = {
  value: number;
  previous: number | null;
  /** Percent change against `previous`, rounded to one decimal; `null` when undefined. */
  changePct: number | null;
};

/**
 * The window actually served, which is not always the one asked for: Free is clamped to
 * `FREE_ANALYTICS_DAYS` and `clampedByPlan` says so, so the UI can snap its control and offer the
 * upgrade instead of quietly showing a different period than the one highlighted.
 *
 * `start` / `end` are inclusive UTC day keys (`YYYY-MM-DD`), like every other day key in the
 * payload — everything on this page is bucketed by UTC day, as on the document pages.
 */
export type WorkspaceRange = {
  /** The range the served window corresponds to; equals `requested` unless the plan clamped it. */
  key: WorkspaceRangeKey;
  /** What the caller asked for, kept so the UI can explain the clamp. */
  requested: WorkspaceRangeKey;
  start: string;
  end: string;
  /** Days served. Authoritative: `key` is a label for it. */
  days: number;
  clampedByPlan: boolean;
  /** The comparison window, or `null` when no comparison is served (Free). */
  previous: { start: string; end: string } | null;
};

/** What the viewer's plan allows, so the UI can lock ranges and gate identities without a second call. */
export type WorkspacePlanInfo = { isPro: boolean; analyticsDays: number | null };

/**
 * The four headline numbers; selecting one drives the hero chart.
 *
 * **Views and Opens are different questions**, and the pair is the whole point of the strip: a view
 * is a recipient active in the window, an open is one tab session, so a reader who came back every
 * morning is one view and five opens and `opens - views` is the returning-reader signal (PRD
 * decision 4). The first cut of this page shipped Viewers here instead, which — `shareviews` being
 * unique per (link, browser) — is the same number as Views on every real payload; two of the four
 * tiles said 584.
 *
 * `viewers` is still a real figure per document and per link, where it is not a duplicate of views,
 * and it is reported there. It is not a headline.
 */
export type WorkspaceHeadline = {
  views: WorkspaceMetricDelta;
  opens: WorkspaceMetricDelta;
  readingTimeMs: WorkspaceMetricDelta;
  downloads: WorkspaceMetricDelta;
};

/**
 * One day of the hero chart. Every day in the range is present, zero-filled, so the chart has no
 * gaps and the area under each series equals its headline figure.
 */
export type WorkspaceSeriesPoint = {
  /** UTC day key, `YYYY-MM-DD`. Format with `formatDayKey` (`src/lib/format/date.ts`). */
  day: string;
  views: number;
  opens: number;
  readingTimeMs: number;
  downloads: number;
};

/** A document row. `href` opens its existing metrics page. */
export type WorkspaceTopDoc = {
  docId: string;
  title: string;
  views: number;
  viewers: number;
  /** Tab sessions on this document in the window (`sharevisits`); a floor when `opensPartial`. */
  opens: number;
  /** Reading time divided by viewers (ms), rounded; `0` when there are no viewers. */
  avgReadingTimeMs: number;
  /** Time read **in the window** (`sharevisits.timeSpentMs`), never the lifetime counter. */
  readingTimeMs: number;
  lastOpenedAt: string | null;
  href: string;
};

/**
 * What a ranked link row points at: one document, or a whole project.
 *
 * The two are different objects with different metrics pages, and the row has to say which it is —
 * a project link's traffic is spread over every document opened through it, so labelling it with a
 * document (and sending it to that document's metrics page) both double-counts it and lands on a
 * page that refuses project-link traffic.
 */
export type WorkspaceTopLinkKind = "doc" | "project";

/**
 * A link row, ranked by views.
 *
 * **One row per `shareId`**, whatever its kind. A project link is a single link that spans several
 * documents, so its views and viewers are summed across the documents opened through it and a
 * reader is counted once for the link rather than once per (link, document) — the first cut grouped
 * on `{ shareId, docId }` and printed the same project link once per document, each row carrying a
 * slice of its traffic under a document's title.
 *
 * `href` opens the metrics page of whatever the link belongs to, filtered to the link: the
 * document's for `kind: "doc"`, the project's for `kind: "project"`.
 */
export type WorkspaceTopLink = {
  shareId: string;
  /** The `ShareLink` id, `null` for a link whose row has been deleted since the views were recorded. */
  shareLinkId: string | null;
  /** Which page this row belongs to; the UI marks a project link with a folder glyph. */
  kind: WorkspaceTopLinkKind;
  label: string;
  audience: string | null;
  isDefault: boolean;
  /** The document a document link points at; `null` on a project link. */
  docId: string | null;
  /** The project a project link points at; `null` on a document link. */
  projectId: string | null;
  /** What the row is under: the document's title, or the project's name. */
  parentName: string;
  views: number;
  viewers: number;
  lastOpenedAt: string | null;
  href: string;
};

/**
 * A named person, ranked by reading time across every document in the workspace.
 *
 * Pro only ([[viewer identity gate]]): passive identification of a reader is a paid capability, so
 * `items` is empty and `gated` is true on Free, which still sees `count`.
 */
export type WorkspacePerson = {
  /** Stable within a response: `e:<lowercased email>` or `u:<userId>`. Not a URL id. */
  key: string;
  name: string | null;
  email: string | null;
  /**
   * Reading time **inside the range**, summed from this person's visits — the same source as the
   * headline tile above the card, never the lifetime `shareviews.timeSpentMs`. `0` for a reader
   * whose traffic predates visit rows: they are still listed, they simply cannot be timed.
   */
  readingTimeMs: number;
  /** Distinct documents this person opened in the range. */
  docs: number;
  lastSeenAt: string | null;
};

export type WorkspacePeople = {
  /** Distinct named people in the range, on both plans. */
  count: number;
  /** Always `[]` on Free. */
  items: WorkspacePerson[];
  /** True when the plan withheld the rows (Free), so the UI shows the upsell rather than "nobody". */
  gated: boolean;
};

/**
 * A shared document with no opens in the range: who to nudge. Newest share first.
 *
 * "Shared" here is the PRD's rule and not the usage meter's: at least one **enabled, unexpired,
 * unarchived** link. A document whose only link is switched off cannot be opened by anyone, so
 * telling its owner to chase the recipient is advice that cannot work.
 */
export type WorkspaceQuietDoc = {
  docId: string;
  title: string;
  /**
   * When the document was most recently shared — the newest live link's creation. Never the
   * document's own `createdDate`: a document with no link has no share date, and dating it by its
   * upload printed "shared 3 days ago" about something that was never sent to anyone.
   */
  sharedAt: string | null;
  href: string;
};

/**
 * What the workspace put out in the range, as opposed to what came back in.
 *
 * `docsShared` counts every live document whose **first** link was created in the window — the same
 * scope as the two figures beside it, and a wider one than `docsOpened.shared`, which follows the
 * usage meter (archived and sharing-off documents excluded). The sentence therefore says "got their
 * first link" rather than "shared", because the two numbers read as a contradiction otherwise.
 */
export type WorkspaceOutput = { docsShared: number; linksCreated: number; uploads: number };

/**
 * One contributor: a person working in the app, or an agent working through the MCP.
 *
 * The rest of this page is what *readers* did; this is what the workspace's own side did, and it
 * keeps the two apart. An agent is credited to its client ("Claude Code"), never folded into the
 * person who holds the key: an agent that filed forty documents overnight and the person who
 * asked for it are different facts, and conflating them hides the one the product exists to show.
 *
 * Counts are actions in the window, from the same work vocabulary the Activity page uses
 * (`ACTIVITY_WORK_TYPES`), so the two surfaces can never disagree about what counts as work.
 */
export type WorkspaceContributor = {
  /** `user:<id>` or `agent:<client>`. */
  key: string;
  kind: "person" | "agent";
  /** A person's name (or email when unnamed), or the agent's client label. */
  name: string;
  /** People only, and only where the app already shows teammates' addresses. */
  email: string | null;
  /** Agents only: the MCP client id, for the glyph and for grouping. */
  client: string | null;
  /** Every counted action, including types with no tile of their own. */
  actions: number;
  docsAdded: number;
  linksCreated: number;
  docsReplaced: number;
  lastActiveAt: string | null;
};

/** `GET /api/metrics/workspace?range=7d|30d|90d`. */
export type WorkspaceMetricsResponse = {
  ok: true;
  range: WorkspaceRange;
  plan: WorkspacePlanInfo;
  headline: WorkspaceHeadline;
  series: WorkspaceSeriesPoint[];
  /**
   * "Opened 12 of 31 shared". `shared` is the same definition as the plan usage meter
   * (`getWorkspaceUsage().documents`: sharing enabled, not deleted, not archived), so the two pages
   * cannot disagree about how many documents a workspace is sharing.
   */
  docsOpened: {
    opened: number;
    shared: number;
    /**
     * Documents that had traffic in the window but are **not** in the `shared` denominator —
     * archived, or sharing switched off. They are in the headline and can be ranked in `topDocs`
     * (the document page still serves them), so the sentence names them rather than leaving a
     * reader to wonder why the list is longer than the count.
     */
    openedOther: number;
    /**
     * Readers who opened something more than once in the window, counted per (link, reader) from
     * the visit rows. Never `opens - views`: that is the number of *surplus sessions*, which ran
     * 1.7x the readers on the seed workspace and would print "77 readers came back" for one reader
     * with 78 sittings. `null` when `opensPartial` makes the visit rows an incomplete floor.
     */
    returningReaders: number | null;
  };
  topDocs: WorkspaceTopDoc[];
  topLinks: WorkspaceTopLink[];
  people: WorkspacePeople;
  quietDocs: WorkspaceQuietDoc[];
  output: WorkspaceOutput;
  /** Who did the work in the window — people and agents, most actions first. */
  contributors: WorkspaceContributor[];
  /**
   * True when `opens` is known to be missing rows, so the UI withholds it instead of printing
   * something impossible.
   *
   * Visit rows only exist from the visit-upsert fix onwards, and every viewer had at least one
   * sitting, so `opens` can never honestly be below `views`. When it is, the traffic predates
   * visits and the figure is a floor, not a count. Identical rule and identical name to the
   * document route's `totals.opensPartial`, so the two pages hide the same number on the same data.
   */
  opensPartial: boolean;
  /** ISO timestamp of the aggregation, so a cached payload can show its age. */
  generatedAt: string;
};

/** Ranked lists are bounded so the payload cannot grow with the workspace. */
export const WORKSPACE_TOP_DOCS_LIMIT = 8;
export const WORKSPACE_TOP_LINKS_LIMIT = 8;
export const WORKSPACE_PEOPLE_LIMIT = 8;
export const WORKSPACE_QUIET_DOCS_LIMIT = 8;
export const WORKSPACE_CONTRIBUTORS_LIMIT = 8;
