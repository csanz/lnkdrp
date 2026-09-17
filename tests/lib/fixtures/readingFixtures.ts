/**
 * Hand-built reading analytics fixtures (spec §3.10). Expectations in the reading* tests are derived
 * from the rules, not from live rows. Also exports sample responses for the reader sheet and metrics
 * page render tests.
 */
import {
  buildPeople,
  buildPersonResponse,
  buildReadingCore,
  buildReadingResponse,
  type LinkInput,
  type Person,
  type PersonResponse,
  type ReadingCore,
  type ReadingResponse,
  type ViewRowInput,
  type VisitInput,
} from "@/lib/analytics/reading";

export const T0 = Date.parse("2026-09-10T12:00:00.000Z");
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** (page, durationMs, reason, toPage) or a gap of wall time between two events. */
export type EventSpec = [page: number, durationMs: number, reason?: string | null, toPage?: number] | { gap: number };

/** Deterministic, distinct 64-hex botIdHash for a label. */
export function hex64(label: string): string {
  let h1 = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < 64; round++) {
    for (const ch of `${label}#${round}`) {
      h1 ^= ch.charCodeAt(0);
      h1 = Math.imul(h1, 0x01000193) >>> 0;
    }
    out += h1.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

/** Deterministic 24-hex user id. */
export function hex24(label: string): string {
  return hex64(`user:${label}`).slice(0, 24);
}

export type VisitSpec = {
  shareId: string;
  botIdHash: string;
  visitId?: string;
  start?: number;
  events: EventSpec[];
  seen?: number[];
  timeSpentMs?: number;
  tv?: number | null;
  /** Wall time between the last event's leftAt and the visit's lastEventAt (default 0). */
  tailMs?: number;
};

let visitCounter = 0;

/** A ShareVisit input with contiguous events from `start` (default T0); timeSpentMs = Σ durations. */
export function makeVisit(spec: VisitSpec): VisitInput {
  const start = spec.start ?? T0;
  let cursor = start;
  let sum = 0;
  const pageEvents: VisitInput["pageEvents"] = [];
  const pages: number[] = [];
  for (const ev of spec.events) {
    if (!Array.isArray(ev)) {
      cursor += ev.gap;
      continue;
    }
    const [pageNumber, durationMs, reason, toPage] = ev;
    pageEvents.push({
      pageNumber,
      enteredAt: new Date(cursor),
      leftAt: new Date(cursor + durationMs),
      durationMs,
      ...(reason !== undefined ? { reason } : {}),
      ...(toPage !== undefined ? { toPage } : {}),
    });
    pages.push(pageNumber);
    cursor += durationMs;
    sum += durationMs;
  }
  const hasReasons = spec.events.some((e) => Array.isArray(e) && e[2] !== undefined);
  visitCounter += 1;
  return {
    visitId: spec.visitId ?? `visit-${String(visitCounter).padStart(5, "0")}`,
    shareId: spec.shareId,
    botIdHash: spec.botIdHash,
    startedAt: new Date(pageEvents.length ? (pageEvents[0].enteredAt as Date) : start),
    lastEventAt: new Date((pageEvents.length ? (pageEvents[pageEvents.length - 1].leftAt as Date).getTime() : start) + (spec.tailMs ?? 0)),
    timeSpentMs: spec.timeSpentMs ?? sum,
    pagesSeen: spec.seen ?? [...new Set(pages)],
    pageEvents,
    timingVersion: spec.tv !== undefined ? spec.tv : hasReasons ? 2 : null,
  };
}

export type RowSpec = Partial<ViewRowInput> & { shareId: string; botIdHash: string };

/** A ShareView input; defaults are anonymous with no downloads. */
export function makeRow(spec: RowSpec & { createdDate: Date | string; updatedDate: Date | string }): ViewRowInput {
  return {
    viewerUserId: null,
    viewerName: null,
    viewerEmail: null,
    viewerEmailSnapshot: null,
    lastViewedAt: spec.updatedDate,
    downloads: 0,
    ...spec,
  };
}

/** Row derived from a person's visits: createdDate = first start, lastViewedAt = updatedDate = last end. */
export function rowForVisits(visits: VisitInput[], overrides: Partial<ViewRowInput> = {}): ViewRowInput {
  const starts = visits.map((v) => new Date(v.startedAt).getTime());
  const ends = visits.map((v) => new Date(v.lastEventAt).getTime());
  const first = new Date(Math.min(...starts));
  const last = new Date(Math.max(...ends));
  return makeRow({
    shareId: visits[0].shareId,
    botIdHash: visits[0].botIdHash,
    createdDate: first,
    lastViewedAt: last,
    updatedDate: last,
    ...overrides,
  });
}

/** A ShareLink input; active, not default, created 10 days before T0 unless overridden. */
export function makeLink(spec: Partial<LinkInput> & { shareId: string }): LinkInput {
  return {
    label: spec.shareId,
    isDefault: false,
    enabled: true,
    expiresAt: null,
    archivedAt: null,
    createdDate: new Date(T0 - 10 * DAY),
    ...spec,
  };
}

export type Fixture = {
  P: number;
  rows: ViewRowInput[];
  visits: VisitInput[];
  links: LinkInput[];
  now: number;
  /** Person keys in the order they were defined. */
  keys: string[];
};

export const SOLO_SHARE = "soloLink01";
export const SOLO_LINK = makeLink({ shareId: SOLO_SHARE, label: "Default link", isDefault: true, createdDate: new Date(T0 - 5 * DAY) });

type PersonDef = { name: string; visits: Array<Omit<VisitSpec, "shareId" | "botIdHash">>; row?: Partial<ViewRowInput>; shareId?: string };

/** Build a fixture from person definitions on one link (or per-person shareIds). */
export function fixture(P: number, defs: PersonDef[], opts: { links?: LinkInput[]; now?: number } = {}): Fixture {
  const rows: ViewRowInput[] = [];
  const visits: VisitInput[] = [];
  const keys: string[] = [];
  for (const d of defs) {
    const shareId = d.shareId ?? SOLO_SHARE;
    const botIdHash = hex64(`${shareId}:${d.name}`);
    const vs = d.visits.map((v) => makeVisit({ ...v, shareId, botIdHash }));
    visits.push(...vs);
    const row = vs.length
      ? rowForVisits(vs, d.row)
      : makeRow({ shareId, botIdHash, createdDate: new Date(T0), updatedDate: new Date(T0), ...d.row });
    rows.push(row);
    keys.push(row.viewerUserId ? `${shareId}|u:${row.viewerUserId}` : `${shareId}|a:${botIdHash}`);
  }
  return { P, rows, visits, links: opts.links ?? [SOLO_LINK], now: opts.now ?? T0 + HOUR, keys };
}

/** People for a fixture, in definition order. */
export function peopleOf(fx: Fixture): Person[] {
  const { people } = buildPeople(fx.rows, fx.visits, fx.links, fx.P, fx.now);
  return fx.keys.map((k) => people.find((p) => p.key === k) as Person);
}

/** The first defined person of a fixture. */
export function personOf(fx: Fixture): Person {
  return peopleOf(fx)[0];
}

/** Doc input with P slide nodes and no labels. */
export function docOf(P: number, labels: Record<number, string> = {}) {
  return {
    slideNodes: Array.from({ length: P }, (_, i) => ({ pageNumber: i + 1, thumbUrl: null as string | null })),
    pageSlugs: Object.entries(labels).map(([page, slug]) => ({ pageNumber: Number(page), slug })),
  };
}

/** A ReadingCore for a fixture. */
export function coreOf(
  fx: Fixture,
  extra: { lastOpenedRows?: Array<{ shareId: string; lastMs: number }>; completedUploads?: number; doc?: ReturnType<typeof docOf> } = {},
): ReadingCore {
  const lastOpenedRows =
    extra.lastOpenedRows ??
    [...new Set(fx.rows.map((r) => r.shareId))].map((shareId) => ({
      shareId,
      lastMs: Math.max(...fx.rows.filter((r) => r.shareId === shareId).map((r) => new Date(r.lastViewedAt ?? r.updatedDate).getTime())),
    }));
  return buildReadingCore({
    rows: fx.rows,
    visits: fx.visits,
    links: fx.links,
    lastOpenedRows,
    doc: extra.doc ?? docOf(fx.P),
    completedUploads: extra.completedUploads ?? 1,
    now: fx.now,
  });
}

// ---------------------------------------------------------------------------------------------
// Single-person fixtures F1–F12, SK1
// ---------------------------------------------------------------------------------------------

export const F1 = fixture(4, [
  {
    name: "F1",
    visits: [{ events: [[1, 4987], [2, 5016], [3, 1519], [4, 4063], [3, 5493], [2, 2199], [3, 5452]], seen: [1, 2, 3, 4] }],
  },
]);

export const F2 = fixture(5, [
  { name: "F2", visits: [{ events: [[1, 3000, "turn"], [2, 4000, "hidden"], { gap: 600_000 }, [2, 6000, "turn"], [3, 25000, "pagehide"]] }] },
]);

export const F3 = fixture(4, [{ name: "F3", visits: [{ events: [[1, 5000, "turn"], [2, 8000, "turn"], [2, 7000, "pagehide"]], seen: [1, 2, 3] }] }]);

export const F4 = fixture(3, [{ name: "F4", visits: [{ events: [[2, 3000], [2, 4000]] }] }]);

export const F5 = fixture(10, [{ name: "F5", visits: [{ events: [[1, 1200, "pagehide"]], seen: [1] }] }]);

export const F6 = fixture(
  6,
  [
    {
      name: "F6",
      visits: [
        { visitId: "f6-v1", start: T0, events: [[1, 20000, "turn"], [2, 30000, "pagehide"]], seen: [1, 2] },
        { visitId: "f6-v2", start: T0 + 70 * HOUR, events: [[5, 40000, "turn"], [6, 50000, "pagehide"]], seen: [1, 5, 6] },
      ],
    },
  ],
  { now: T0 + 71 * HOUR },
);

export const F7 = fixture(4, [{ name: "F7", visits: [{ events: [], seen: [1, 2], timeSpentMs: 9000 }] }]);

export const F8 = fixture(3, [{ name: "F8", visits: [{ events: [[1, 12000, "turn"], [2, 15000, "turn"], [3, 11000, "pagehide"]] }] }]);

export const F9 = fixture(2, [{ name: "F9", visits: [{ events: [[1, 900_000, "idle"]] }] }], { now: T0 + 2 * HOUR });

export const F10 = fixture(4, [{ name: "F10", visits: [{ events: [[7, 5000]], seen: [1, 7] }] }]);

export const F11 = fixture(1, [{ name: "F11", visits: [{ events: [[1, 15000, "pagehide"]] }] }]);

export const F12 = fixture(3, [{ name: "F12", visits: [{ events: [[1, 12000, "turn"], [2, 1800, "turn"], [3, 15000, "pagehide"]] }] }]);

export const SK1 = fixture(10, [{ name: "SK1", visits: [{ events: [[10, 3000, "pagehide"]], seen: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }] }]);

// ---------------------------------------------------------------------------------------------
// Live-found shapes: lost final flush, jumpers, short intense readers, flipped-through stops
// ---------------------------------------------------------------------------------------------

/** Turned page by page through 1..11; the last event is the turn to 12 (its flush was lost). */
export const NADIA = fixture(12, [
  {
    name: "Nadia",
    visits: [{ events: Array.from({ length: 11 }, (_, i): EventSpec => [i + 1, 5000, "turn", i + 2]), seen: Array.from({ length: 12 }, (_, i) => i + 1) }],
  },
]);

/** Stayed on page 1, turned to 2, then the tab died. */
export const MAYA = fixture(12, [{ name: "Maya", visits: [{ events: [[1, 5336, "turn", 2]], seen: [1, 2] }] }]);

/** A legacy turn without toPage keeps the page-of-the-latest-event rule. */
export const LEGACY_TURN = fixture(12, [{ name: "Legacy", visits: [{ events: [[1, 5336, "turn"]], seen: [1, 2] }] }]);

/**
 * Anonymous reader 16's shape: timed only on page 2 (turn → 3) and page 5 (turn → 6), pages 1–8 seen,
 * and activity 2.15s after the last flush, so pages 7–8 were flipped to after the lost turn.
 */
export const LF1 = fixture(12, [
  { name: "LF1", visits: [{ events: [[2, 6730, "turn", 3], [5, 3479, "turn", 6]], seen: [1, 2, 3, 4, 5, 6, 7, 8], tailMs: 2150 }] },
]);

/** LF1 with no activity after the last flush. */
export const LF2 = fixture(12, [{ name: "LF2", visits: [{ events: [[2, 6730, "turn", 3], [5, 3479, "turn", 6]], seen: [1, 2, 3, 4, 5, 6, 7, 8] }] }]);

/** Opened page 1, jumped straight to page 10 of 13 and left there. */
export const ISAAC = fixture(13, [{ name: "Isaac", visits: [{ events: [[1, 7700, "turn", 10], [10, 57900, "pagehide"]], seen: [1, 10] }] }]);

/** A short, intense reader: 4.7s on page 1, 70s on page 2, then left. */
export const INTENSE = fixture(12, [{ name: "Intense", visits: [{ events: [[1, 4700, "turn", 2], [2, 70000, "pagehide"]], seen: [1, 2] }] }]);

/** Flipped 1 → 11 → 12 (no timed stop) → 11 → 10. */
export const FLIPPER = fixture(12, [
  {
    name: "Flipper",
    visits: [{ events: [[1, 4000, "turn", 11], [11, 6000, "turn", 12], [11, 3000, "turn", 10], [10, 9000, "pagehide"]], seen: [1, 10, 11, 12] }],
  },
]);

/**
 * Nadia's standout shape: 34s on page 7 where three others take 10s, 42s on page 10 where they take
 * 30s. Page 7 is the one that held her.
 */
export const NADIA_STANDOUT = fixture(12, [
  {
    name: "NadiaStandout",
    visits: [
      {
        events: Array.from({ length: 12 }, (_, i): EventSpec => {
          const page = i + 1;
          const ms = page === 7 ? 34000 : page === 10 ? 42000 : 5000;
          return page < 12 ? [page, ms, "turn", page + 1] : [page, ms, "pagehide"];
        }),
      },
    ],
  },
  ...[1, 2, 3].map((i) => ({ name: `nsPeer${i}`, visits: [{ events: [[1, 4000, "turn", 7], [7, 10000, "turn", 10], [10, 30000, "pagehide"]] as EventSpec[], seen: [1, 7, 10] }] })),
]);

/** Brightwater Anonymous reader 1: jumped around, 1m 44s on page 9. */
export const JUMPER_LONG = fixture(13, [
  { name: "JumperLong", visits: [{ events: [[1, 4000, "turn", 6], [6, 65000, "turn", 9], [9, 104000, "turn", 8], [8, 62000, "pagehide"]], seen: [1, 6, 8, 9] }] },
]);

/** Priya: stayed on all 13 pages, with pages 10–12 in a near tie for longest. */
export const PRIYA = fixture(13, [
  {
    name: "Priya",
    visits: [
      {
        events: Array.from({ length: 13 }, (_, i): EventSpec => {
          const page = i + 1;
          const ms = page === 10 ? 60000 : page === 11 ? 58663 : page === 12 ? 59050 : 20000;
          return page < 13 ? [page, ms, "turn", page + 1] : [page, ms, "pagehide"];
        }),
      },
    ],
  },
]);

/**
 * Samuel's shape: 2m 50s on page 9 where five others take 8s, then back 4 days later for pages 1 and
 * 12. Page 1 is timed in both visits.
 */
export const SAMUEL = fixture(13, [
  {
    name: "Samuel",
    visits: [
      { visitId: "samuel-v1", start: T0, events: [[1, 6000, "turn", 9], [9, 170541, "pagehide"]], seen: [1, 9] },
      { visitId: "samuel-v2", start: T0 + 4 * DAY, events: [[1, 4000, "turn", 12], [12, 5000, "pagehide"]], seen: [1, 12] },
    ],
  },
  ...[1, 2, 3, 4, 5].map((i) => ({ name: `samPeer${i}`, visits: [{ start: T0, events: [[1, 4000, "turn", 9], [9, 8000, "pagehide"]] as EventSpec[], seen: [1, 9] }] })),
], { now: T0 + 4 * DAY + HOUR });

/**
 * Anonymous reader 21's shape: pages 1–6, jumped to 10, 11, flicked past 12 in a second, then came
 * back later the same day to page 1 and page 10, where they left.
 */
export const LAST_PAGE_PASSED = fixture(12, [
  {
    name: "LastPassed",
    visits: [
      {
        visitId: "lp-v1",
        start: T0,
        events: [
          ...Array.from({ length: 6 }, (_, i): EventSpec => [i + 1, 5000, "turn", i === 5 ? 10 : i + 2]),
          [10, 9000, "turn", 11],
          [11, 7000, "turn", 12],
          [12, 1000, "pagehide"],
        ],
      },
      { visitId: "lp-v2", start: T0 + 2 * HOUR, events: [[1, 4000, "turn", 10], [10, 12000, "pagehide"]], seen: [1, 10] },
    ],
  },
], { now: T0 + 3 * HOUR });

/** Reader 6's shape: 1 → 10 → 9 → 4, left on 4. */
export const BACKWARDS = fixture(12, [
  { name: "Backwards", visits: [{ events: [[1, 5000, "turn", 10], [10, 8000, "turn", 9], [9, 6000, "turn", 4], [4, 7000, "pagehide"]] }] },
]);

/** F8's reading with one download. */
export const DOWNLOADER = fixture(3, [
  { name: "Downloader", visits: [{ events: [[1, 12000, "turn"], [2, 15000, "turn"], [3, 11000, "pagehide"]] }], row: { downloads: 1 } },
]);

/**
 * Six people stayed on page 2 (an even count): 60s, 30s, 20s, 12s, 10s, 10s. The inclusive median is
 * 16s, so 60s is 3.7×; leaving the 60s out would have made it 12s and 5.0×.
 */
export const EVEN_TYPICAL = fixture(4, [
  { name: "evenTarget", visits: [{ events: [[1, 4000, "turn", 2], [2, 60000, "turn", 3], [3, 4000, "pagehide"]] }] },
  ...[30000, 20000, 12000, 10000, 10000].map((ms, i) => ({
    name: `evenPeer${i}`,
    visits: [{ events: [[1, 4000, "turn", 2], [2, ms, "turn", 3], [3, 4000, "pagehide"]] as EventSpec[] }],
  })),
]);

// ---------------------------------------------------------------------------------------------
// SR1–SR3: single reader vs peers
// ---------------------------------------------------------------------------------------------

const SR1_DEF: PersonDef = { name: "SR1", visits: [{ events: [[1, 3000, "turn"], [2, 40000, "turn"], [3, 4000, "pagehide"]] }] };
const peer = (i: number): PersonDef => ({ name: `SRpeer${i}`, visits: [{ events: [[1, 4000, "turn"], [2, 4000, "pagehide"]] }] });

export const SR1 = fixture(4, [SR1_DEF]);
export const SR2 = fixture(4, [SR1_DEF, peer(1), peer(2)]);
export const SR3 = fixture(4, [SR1_DEF, peer(1), peer(2), peer(3)]);

// ---------------------------------------------------------------------------------------------
// PT1 / AT1 / AT2 / RESP1
// ---------------------------------------------------------------------------------------------

export const L0 = "shareL0def";
export const L1 = "shareL1seq";
export const L2 = "shareL2acc";
export const L3 = "shareL3old";
export const ORPHAN = "ZZorphan1";

export const PT1_NOW = T0 + 3_600_000;

const PT1_DEFS: PersonDef[] = [
  {
    name: "A",
    shareId: L0,
    visits: [{ start: T0 + 3_251_000, events: [[1, 5000, "turn"], [2, 30000, "turn"], [3, 8000, "turn"], [4, 6000, "pagehide"]], seen: [1, 2, 3, 4] }],
    row: { lastViewedAt: new Date(T0 + 3_300_000), updatedDate: new Date(T0 + 3_300_000) },
  },
  {
    name: "B",
    shareId: L0,
    visits: [{ events: [[1, 4000, "turn"], [3, 20000, "pagehide"]], seen: [1, 2, 3] }],
    row: { lastViewedAt: new Date(T0 + 600_000), updatedDate: new Date(T0 + 600_000) },
  },
  {
    name: "C",
    shareId: L0,
    visits: [{ events: [[1, 3000, "pagehide"]], seen: [1] }],
    row: { lastViewedAt: new Date(T0 + 60_000), updatedDate: new Date(T0 + 60_000) },
  },
  {
    name: "D",
    shareId: L0,
    visits: [{ events: [[1, 6000, "turn"], [2, 40000, "turn"], [3, 1800, "pagehide"]], seen: [1, 2, 3] }],
    row: { lastViewedAt: new Date(T0 + 1_200_000), updatedDate: new Date(T0 + 1_200_000) },
  },
  {
    name: "E",
    shareId: L0,
    visits: [{ events: [[1, 2500, "turn"], [2, 10000, "turn"], [4, 9000, "pagehide"]], seen: [1, 2, 3, 4] }],
    row: { lastViewedAt: new Date(T0 + 1_800_000), updatedDate: new Date(T0 + 1_800_000) },
  },
];

export const AT1_LINKS: LinkInput[] = [
  makeLink({ shareId: L0, label: "Default link", isDefault: true, createdDate: new Date(PT1_NOW - 96 * HOUR) }),
  makeLink({ shareId: L1, label: "Sequoia", createdDate: new Date(PT1_NOW - 72 * HOUR) }),
  makeLink({ shareId: L2, label: "Accel", createdDate: new Date(PT1_NOW - 24 * HOUR) }),
  makeLink({ shareId: L3, label: "Old", enabled: false, createdDate: new Date(PT1_NOW - 200 * HOUR) }),
];

/** PT1 people on L0 with the AT1 links. */
export const PT1 = fixture(4, PT1_DEFS, { links: AT1_LINKS, now: PT1_NOW });
export const AT1 = PT1;

export const AT2_LINKS: LinkInput[] = [
  makeLink({ shareId: L0, label: "Default link", isDefault: true, createdDate: new Date(PT1_NOW - 200 * HOUR) }),
  ...[1, 2, 3, 4, 5, 6].map((i) => makeLink({ shareId: `shareN${i}xx`, label: `N${i}`, createdDate: new Date(PT1_NOW - (100 + i) * HOUR) })),
];
export const AT2 = fixture(4, PT1_DEFS, { links: AT2_LINKS, now: PT1_NOW });

/** PT1/AT1 plus person Z on a shareId with no ShareLink row. */
export const RESP1 = fixture(
  4,
  [
    ...PT1_DEFS,
    {
      name: "Z",
      shareId: ORPHAN,
      visits: [{ start: T0, events: [[1, 5000, "pagehide"]], seen: [1] }],
      row: { createdDate: new Date(T0), lastViewedAt: new Date(T0), updatedDate: new Date(T0) },
    },
  ],
  { links: AT1_LINKS, now: PT1_NOW },
);

export const RESP1_LAST_OPENED = [
  { shareId: L0, lastMs: T0 + 3_300_000 },
  { shareId: ORPHAN, lastMs: T0 },
];

export const RESP1_CORE = coreOf(RESP1, { lastOpenedRows: RESP1_LAST_OPENED });

// ---------------------------------------------------------------------------------------------
// Sample responses for the reader sheet and metrics page render tests
// ---------------------------------------------------------------------------------------------

const PT1_CORE = coreOf(PT1, { lastOpenedRows: [{ shareId: L0, lastMs: T0 + 3_300_000 }] });

export const readingResponseDeepPT1: ReadingResponse = buildReadingResponse(PT1_CORE, {
  tier: "deep",
  days: 30,
  daysLimit: null,
  shareId: null,
  matrixLimit: 25,
  now: PT1_NOW,
});

export const readingResponseBasicAT1: ReadingResponse = buildReadingResponse(PT1_CORE, {
  tier: "basic",
  days: 7,
  daysLimit: 7,
  shareId: null,
  matrixLimit: 25,
  now: PT1_NOW,
});

function personResponseFor(fx: Fixture, core: ReadingCore, key: string): PersonResponse {
  const person = core.people.find((p) => p.key === key) as Person;
  return buildPersonResponse(core, person, { days: 30, now: fx.now });
}

export const personResponseF1: PersonResponse = personResponseFor(F1, coreOf(F1), F1.keys[0]);
export const personResponseF6: PersonResponse = personResponseFor(F6, coreOf(F6), F6.keys[0]);
export const personResponsePT1A: PersonResponse = personResponseFor(PT1, PT1_CORE, PT1.keys[0]);
