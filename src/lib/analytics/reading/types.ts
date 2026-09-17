/**
 * Types for document reading analytics: raw inputs (as loaded from ShareView, ShareVisit, ShareLink
 * and Doc), the normalised intermediate shapes, and the JSON shapes the `/pages` endpoints return.
 *
 * Code identifiers keep the word "read" (`readCount`, `readPages`, cell state `"read"`) for a page a
 * person stayed on for READ_MIN_MS or more; UI copy calls that "stayed".
 */

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

export type RawPageEvent = {
  pageNumber: unknown;
  enteredAt: Date | string | null;
  leftAt: Date | string | null;
  durationMs: unknown;
  reason?: string | null;
  /** Page a "turn" moved to. */
  toPage?: unknown;
};

export type VisitInput = {
  visitId: string;
  shareId: string;
  botIdHash: string;
  startedAt: Date | string;
  lastEventAt: Date | string;
  timeSpentMs: number;
  pagesSeen: unknown[];
  pageEvents: RawPageEvent[];
  timingVersion?: number | null;
};

export type ViewRowInput = {
  shareId: string;
  botIdHash: string;
  viewerUserId: string | null;
  viewerName: string | null;
  viewerEmail: string | null;
  viewerEmailSnapshot: string | null;
  createdDate: Date | string;
  lastViewedAt: Date | string | null;
  updatedDate: Date | string;
  downloads: number;
};

export type LinkInput = {
  shareId: string;
  label: string;
  isDefault: boolean;
  enabled: boolean;
  expiresAt: Date | string | null;
  archivedAt: Date | string | null;
  createdDate: Date | string;
};

/** `shortLabel`: the section role alone ("Team") for a recognised "{role}-{heading}" slug, else `label`. */
export type PageMeta = { page: number; label: string | null; shortLabel: string | null; thumbUrl: string | null };

/** One person key's all-time ShareView aggregate. `introduced`: some row carries a name or email. */
export type AllTimePerson = { key: string; shareId: string; firstMs: number; lastMs: number; anonymousKey: boolean; introduced: boolean };

// ---------------------------------------------------------------------------------------------
// Normalised visits and people
// ---------------------------------------------------------------------------------------------

/** `toPage` is the last event's turn target (1..P) when that event was a turn, else null. */
export type Stop = { page: number; ms: number; revisit: boolean; reason: string | null; toPage: number | null };

export type NormalizedVisit = {
  visitId: string;
  shareId: string;
  botIdHash: string;
  startedAtMs: number;
  lastEventAtMs: number;
  timeSpentMs: number;
  timed: boolean;
  seen: number[];
  dwellByPage: number[];
  stopsByPage: number[];
  stops: Stop[];
  exitPage: number | null;
  exitInferred: boolean;
  /**
   * When the final timed event is a turn whose flush was lost: the turn's target plus every later
   * seen page with no timed event in this visit, ascending. Their time is unknown. Empty otherwise.
   */
  untimedTail: number[];
  droppedEvents: number;
  tv2: boolean;
};

export type IdentitySource = "signed_in" | "introduced" | "anonymous";
/** "jumped": not seen but before the person's furthest page; "unreached": after it. */
export type CellState = "read" | "passed" | "unknown" | "jumped" | "unreached";
export type Cell = { ms: number; state: CellState; revisit: boolean };

export type Person = {
  personId: string;
  key: string;
  shareId: string;
  linkLabel: string;
  isDefaultLink: boolean;
  name: string;
  /** Doc-wide, all-time rank of an anonymous person ("Anonymous reader {n}"); null otherwise. */
  anonNumber: number | null;
  source: IdentitySource;
  email: string | null;
  firstSeenMs: number;
  lastSeenMs: number;
  downloads: number;
  visits: NormalizedVisit[];
  hasDetail: boolean;
  timed: boolean;
  seen: number[];
  maxPage: number;
  reachedCount: number;
  readPages: number;
  dwellByPage: number[];
  revisitsByPage: number[];
  totalMs: number;
  latestVisit: NormalizedVisit | null;
  exitPage: number | null;
  lastEventAtMs: number | null;
  cells: Cell[];
};

// ---------------------------------------------------------------------------------------------
// Page table, attention, verdict
// ---------------------------------------------------------------------------------------------

export type PageRow = {
  page: number;
  label: string | null;
  shortLabel: string | null;
  thumbUrl: string | null;
  reached: number;
  readCount: number;
  typicalMs: number | null;
  /** Stayed dwells, longest first, when 1 ≤ readCount < TYPICAL_MIN_READERS; else null. */
  fewMs: number[] | null;
  passed: number;
  /** People who went past this page without it ever being on screen (= stillReading − reached). */
  jumped: number;
  leftHere: number;
  stillReading: number;
};

export type Callouts = {
  /**
   * Only pages at least CALLOUT_MIN_PEOPLE stayed on; tiedPages (includes page) are within 5% of its
   * typical time, and `tied` carries each of them (leader included, page ascending). Null when too many
   * pages tie or the leader is under 1.25× the median typical time of those pages.
   */
  heldLongest: {
    page: number;
    typicalMs: number;
    readCount: number;
    tiedPages: number[];
    tied: Array<{ page: number; typicalMs: number; readCount: number }>;
  } | null;
  /** skipped = passed + jumped, of = stillReading; tiedPages includes page. */
  mostSkipped: { page: number; skipped: number; of: number; tiedPages: number[] } | null;
  mostLeft: { page: number; leftHere: number; people: number; tiedPages: number[] } | null;
};

export type HotReason =
  /** fromAt: the earlier visit's last activity; toAt: the later visit's start (ISO), for the largest gap. */
  | { kind: "returned"; gapMs: number; fromAt: string; toAt: string }
  | { kind: "read_most"; read: number; pageCount: number; totalMs: number }
  /**
   * ms: the person's dwell on `page`. ratio: against docTypicalMs, the doc's median stayed-page time
   * over other people. pageTypicalMs: the page table's typical time for this page, and pageRatio
   * against it, both null unless CALLOUT_MIN_PEOPLE stayed on the page.
   */
  | { kind: "dwell"; page: number; ms: number; ratio: number; pageTypicalMs: number | null; pageRatio: number | null; docTypicalMs: number };

export type AttentionRow =
  | { kind: "active"; personId: string; name: string; linkLabel: string; page: number | null; at: string; totalMs: number; exitPage: number | null }
  | { kind: "hot"; personId: string; name: string; linkLabel: string; reason: HotReason; lastSeen: string; totalMs: number; exitPage: number | null }
  | { kind: "not_opened"; shareId: string; linkLabel: string; sentAt: string };

/** `page`: the page the behaviour clause names (standout page or went-back page), else null. */
export type Verdict = { coverage: string | null; behaviour: string | null; text: string; page: number | null };

// ---------------------------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------------------------

export type ReadingTier = "basic" | "deep";
export type LinkStatus = "active" | "disabled" | "expired" | "archived" | "deleted";

export type LinkRow = {
  shareId: string;
  label: string;
  isDefault: boolean;
  status: LinkStatus;
  createdAt: string | null;
  people: number;
  lastOpenedAt: string | null;
  everOpened: boolean;
  lastOpenedAtAllTime: string | null;
  /** Deep only. */
  reachedEnd?: number;
  /** Deep only. */
  peopleWithDetail?: number;
  /** Deep only. */
  medianTotalMs?: number | null;
};

export type MatrixRow = {
  personId: string;
  name: string;
  anonNumber: number | null;
  source: IdentitySource;
  email: string | null;
  shareId: string;
  linkLabel: string;
  lastSeen: string;
  totalMs: number;
  reachedCount: number;
  readPages: number;
  maxPage: number;
  exitPage: number | null;
  activeNow: boolean;
  hot: HotReason | null;
  cells: Cell[];
};

export type ReadingResponse = {
  ok: true;
  tier: ReadingTier;
  days: number;
  daysLimit: number | null;
  shareId: string | null;
  generatedAt: string;
  people: number;
  /** In-range visit time summed over the scoped people (both tiers). */
  totalMs: number;
  lastOpenedAt: string | null;
  everOpened: boolean;
  lastOpenedAtAllTime: string | null;
  links: LinkRow[];
  /** Active then hot people (up to ATTENTION_LIST_MAX; `more` counts hidden ones), then every unopened link. */
  attention: { rows: AttentionRow[]; more: number };
  /** Scoped people by the day (YYYY-MM-DD in the request's time zone) of their last activity; zero-filled, ascending. */
  series: Array<{ day: string; people: number }>;
  pageCount?: number;
  peopleWithDetail?: number;
  multipleVersions?: boolean;
  pages?: PageRow[];
  callouts?: Callouts | null;
  calloutGate?: string | null;
  matrix?: { rows: MatrixRow[]; total: number; limit: number };
  totals?: { reachedEnd: number; medianTotalMs: number | null };
  coverage?: { truncated: boolean; droppedEvents: number; unmatchedVisits: number };
};

export type PersonPageRow = {
  page: number;
  label: string | null;
  shortLabel: string | null;
  thumbUrl: string | null;
  ms: number;
  state: CellState;
  revisits: number;
  /** The page table's typical time for this page (null below TYPICAL_MIN_READERS). */
  typicalMs: number | null;
  /** People who stayed on this page (the page table's readCount). */
  readCount: number;
  /** ms / typicalMs floored to one decimal; only for a stayed page with readCount ≥ CALLOUT_MIN_PEOPLE. */
  ratio: number | null;
  leftHere: boolean;
};

export type PersonVisitRow = {
  visitId: string;
  startedAt: string;
  endedAt: string;
  totalMs: number;
  timed: boolean;
  exitPage: number | null;
  exitInferred: boolean;
  /**
   * `passed` steps are pages a turn landed on with no timed stop there (ms 0). `untimed` steps (ms 0)
   * are the target of a final turn whose flush was lost, then the later pages seen after it.
   */
  stops: Array<{ page: number; ms: number; revisit: boolean; passed: boolean; untimed: boolean }>;
  seen: number[];
  /** Seen pages under READ_MIN_MS, excluding the untimed tail. */
  passedPages: number[];
};

export type PersonResponse = {
  ok: true;
  days: number;
  pageCount: number;
  multipleVersions: boolean;
  person: {
    personId: string;
    name: string;
    anonNumber: number | null;
    source: IdentitySource;
    email: string | null;
    shareId: string;
    linkLabel: string;
    isDefaultLink: boolean;
    firstSeen: string;
    lastSeen: string;
    downloads: number;
    hot: HotReason | null;
    activeNow: boolean;
  };
  verdict: Verdict;
  /** typicalTotalMs: median total time of everyone with page detail and time, as the KPI (null below 3 of them). */
  facts: { visits: number; totalMs: number; reachedCount: number; maxPage: number; exitPage: number | null; typicalTotalMs: number | null };
  pages: PersonPageRow[];
  visits: PersonVisitRow[];
  more: { visits: number };
};

export type ReadingCore = {
  P: number;
  meta: PageMeta[];
  links: LinkInput[];
  people: Person[];
  lastOpenedByShareId: Map<string, number>;
  /** All-time activity per person key (not range-limited), from the loader's aggregate. */
  allTimeByKey: Map<string, AllTimePerson>;
  /** Doc-wide anonymous ranks by person key, all time when the loader supplied them. */
  anonNumberByKey: Map<string, number>;
  hotByKey: Map<string, HotReason | null>;
  docPages: PageRow[];
  multipleVersions: boolean;
  truncated: boolean;
  droppedEvents: number;
  unmatchedVisits: number;
};

/** Top-level keys a Free (basic) response may carry; anything else is per-person/per-page detail. */
export const BASIC_READING_KEYS = [
  "ok",
  "tier",
  "days",
  "daysLimit",
  "shareId",
  "generatedAt",
  "people",
  "totalMs",
  "lastOpenedAt",
  "everOpened",
  "lastOpenedAtAllTime",
  "links",
  "attention",
  "series",
] as const;

/** Link row keys a Free (basic) response may carry. */
export const BASIC_LINK_KEYS = [
  "shareId",
  "label",
  "isDefault",
  "status",
  "createdAt",
  "people",
  "lastOpenedAt",
  "everOpened",
  "lastOpenedAtAllTime",
] as const;
