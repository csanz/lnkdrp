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

export type PageMeta = { page: number; label: string | null; thumbUrl: string | null };

// ---------------------------------------------------------------------------------------------
// Normalised visits and people
// ---------------------------------------------------------------------------------------------

export type Stop = { page: number; ms: number; revisit: boolean; reason: string | null };

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
  droppedEvents: number;
  tv2: boolean;
};

export type IdentitySource = "signed_in" | "introduced" | "anonymous";
export type CellState = "read" | "passed" | "unknown" | "unreached";
export type Cell = { ms: number; state: CellState; revisit: boolean };

export type Person = {
  personId: string;
  key: string;
  shareId: string;
  linkLabel: string;
  isDefaultLink: boolean;
  name: string;
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
  thumbUrl: string | null;
  reached: number;
  readCount: number;
  typicalMs: number | null;
  passed: number;
  leftHere: number;
  stillReading: number;
};

export type Callouts = {
  heldLongest: { page: number; typicalMs: number; readCount: number } | null;
  mostPassed: { page: number; passed: number; reached: number } | null;
  mostLeft: { page: number; leftHere: number; people: number } | null;
};

export type HotReason =
  | { kind: "returned"; gapMs: number }
  | { kind: "read_most"; read: number; pageCount: number }
  | { kind: "dwell"; page: number; ratio: number };

export type AttentionRow =
  | { kind: "active"; personId: string; name: string; linkLabel: string; page: number | null; at: string }
  | { kind: "hot"; personId: string; name: string; linkLabel: string; reason: HotReason }
  | { kind: "not_opened"; shareId: string; linkLabel: string; sentAt: string };

export type Verdict = { coverage: string | null; behaviour: string | null; text: string };

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
  attention: { rows: AttentionRow[]; more: number };
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
  thumbUrl: string | null;
  ms: number;
  state: CellState;
  revisits: number;
  typicalMs: number | null;
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
  stops: Array<{ page: number; ms: number; revisit: boolean }>;
  seen: number[];
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
  facts: { visits: number; totalMs: number; reachedCount: number; maxPage: number; exitPage: number | null };
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
