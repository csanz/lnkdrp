/**
 * The traffic plan for a seeded corpus: who reads which document through which link, when, and how.
 *
 * Pure: every choice comes from `mulberry32` streams derived from `seed`, and every timestamp from
 * `runStart` (passed in). Rebuilding the plan from the manifest therefore reproduces it exactly, which
 * is what lets the fix-up, a resumed run and a `--live-only` rerun agree with the first run.
 */
import { hashString, mulberry32, roleProfile } from "./content";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type Archetype = "bouncer" | "skimmer" | "reader" | "jumper" | "returner" | "stopper";

export const ARCHETYPE_SHARES: Record<Archetype, number> = {
  bouncer: 0.15,
  skimmer: 0.25,
  reader: 0.25,
  jumper: 0.15,
  returner: 0.12,
  stopper: 0.08,
};

export type PlanLink = {
  shareId: string;
  label: string;
  isDefault: boolean;
  allowDownload: boolean;
  enabled?: boolean;
  archivedAt?: string | number | null;
  expiresAt?: string | number | null;
};

export type PlanDocInput = { slug: string; docId: string; pages: string[]; links: PlanLink[] };

export type PlanInput = { tag: string; seed: number; runStart: number; docs: PlanDocInput[]; smoke?: boolean };

export type PlannedStop = { page: number; ms: number; flip: boolean };

export type PlannedVisit = {
  visitId: string;
  startAt: number;
  durationMs: number;
  endAt: number;
  stops: PlannedStop[];
  hiddenSplit: { stopIndex: number; afterMs: number; gapMs: number } | null;
  idle: { stopIndex: number; afterMs: number; idleMs: number } | null;
  killed: boolean;
  rngSeed: number;
  /** Return visits only: what the person came back for. */
  returnStyle?: ReturnStyle;
};

export type PlannedPerson = {
  n: number;
  botId: string;
  docId: string;
  slug: string;
  shareId: string;
  linkLabel: string;
  archetype: Archetype;
  ip: string;
  intro: { viewerName: string; viewerEmail: string } | null;
  visits: PlannedVisit[];
  download: { atMs: number } | null;
  live: boolean;
  batch: number | null;
  ownerPreview: boolean;
  /** Live tail only: the visit ends this long before it is sent. */
  endsAgoMs: number | null;
};

export type PlannedLink = PlanLink & { createdAt: number; weight: number };

export type PlannedDoc = {
  docId: string;
  slug: string;
  roles: string[];
  pageCount: number;
  createdAt: number;
  bucket: string;
  people: number;
  links: PlannedLink[];
};

export type RefusedLink = {
  docId: string;
  shareId: string;
  label: string;
  kind: "disabled" | "expired";
  maxEnd: number;
  disableAt: number;
};

export type Plan = {
  tag: string;
  seed: number;
  runStart: number;
  smoke: boolean;
  docs: PlannedDoc[];
  /** Bulk readers (backdated by the fix-up). */
  people: PlannedPerson[];
  /** Owner-cookie opens: recorded, never counted as people. */
  ownerPreviews: PlannedPerson[];
  refused: RefusedLink[];
  refusedShareIds: string[];
  /** Live tail batch 0 (sent after the fix-up, never backdated). */
  live: PlannedPerson[];
  skipped: string[];
};

type Rng = () => number;

export function rngFor(seed: number, label: string): Rng {
  return mulberry32(hashString(`${seed}|${label}`));
}

const uniform = (r: Rng, lo: number, hi: number) => lo + r() * (hi - lo);
const randInt = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

function normal(r: Rng): number {
  const u = Math.max(r(), 1e-12);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function shuffle<T>(r: Rng, xs: readonly T[]): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function weightedIndex(r: Rng, weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return -1;
  let x = r() * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i]!;
    if (x < 0 && weights[i]! > 0) return i;
  }
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i]! > 0) return i;
  return -1;
}

const IP_NETS = ["198.51.100", "203.0.113", "192.0.2"] as const;

/** A stable documentation-range address per person (762 distinct before wrapping). */
export function ipFor(n: number): string {
  const idx = n % 762;
  return `${IP_NETS[idx % 3]}.${1 + Math.floor(idx / 3)}`;
}

export function botIdFor(tag: string, n: number): string {
  return `b_seed_${tag}_${n}`;
}

const FIRST = [
  "Dana", "Priya", "Marcus", "Ines", "Tomas", "Amara", "Noor", "Felix", "Grace", "Hiro", "Leila", "Mateo", "Sofia", "Owen",
  "Chloe", "Rafael", "Yuki", "Elena", "Samuel", "Aisha", "Jonas", "Maya", "Diego", "Hannah", "Kwame", "Lucia", "Omar", "Freya",
  "Victor", "Zara", "Isaac", "Nadia", "Theo", "Camila", "Arjun", "Ruth", "Emil", "Beatriz", "Caleb", "Mina",
] as const;
const LAST = [
  "Whitfield", "Okafor", "Lindqvist", "Haddad", "Moreau", "Castellanos", "Tanaka", "Brennan", "Novak", "Achebe", "Ferreira",
  "Kowalski", "Nguyen", "Adeyemi", "Larsen", "Romano", "Singh", "Duarte", "Fischer", "Mensah", "Petrov", "Alvarez", "Kim",
  "Oduya", "Laurent", "Sato", "Horvat", "Delgado", "Byrne", "Varga", "Chen", "Abara", "Nilsen", "Costa", "Reyes", "Park",
  "Ivanova", "Mbeki", "Hughes", "Quinn",
] as const;

function firmFromLabel(label: string): string {
  const head = label.split(" — ")[0] ?? label;
  const word = head.split(/\s+/)[0] ?? "firm";
  const firm = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  return firm || "firm";
}

function pickIntro(r: Rng, used: Set<string>, linkLabel: string): { viewerName: string; viewerEmail: string } {
  for (let attempt = 0; attempt < 200; attempt++) {
    const first = FIRST[Math.floor(r() * FIRST.length)]!;
    const last = LAST[Math.floor(r() * LAST.length)]!;
    const name = `${first} ${last}`;
    if (used.has(name)) continue;
    used.add(name);
    return { viewerName: name, viewerEmail: `${first}.${last}@${firmFromLabel(linkLabel)}.test`.toLowerCase() };
  }
  const name = `Reader ${used.size + 1}`;
  used.add(name);
  return { viewerName: name, viewerEmail: `reader${used.size}@${firmFromLabel(linkLabel)}.test` };
}

const NY_FORMAT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" });

function nyMinuteOfDay(ms: number): number {
  let h = 0;
  let m = 0;
  for (const p of NY_FORMAT.formatToParts(new Date(ms))) {
    if (p.type === "hour") h = Number(p.value) % 24;
    if (p.type === "minute") m = Number(p.value);
  }
  return h * 60 + m;
}

/** Move a time forward into 08:00-19:00 New York, when it falls outside. */
function intoWorkHours(r: Rng, t: number): number {
  const mod = nyMinuteOfDay(t);
  if (mod >= 8 * 60 && mod < 19 * 60) return t;
  const toEight = mod < 8 * 60 ? 8 * 60 - mod : 24 * 60 - mod + 8 * 60;
  return t + toEight * MINUTE + Math.floor(uniform(r, 0, 11 * HOUR));
}

function readerDwell(r: Rng, role: string): number {
  const ms = 14_000 * Math.exp(0.5 * normal(r)) * roleProfile(role).interest;
  return Math.round(Math.min(240_000, Math.max(2000, ms)));
}

function stay(page: number, ms: number): PlannedStop {
  return { page, ms: Math.round(ms), flip: false };
}

/** Stops for each visit of one archetype (two visits for a returner). */
function buildStops(archetype: Archetype, roles: string[], r: Rng): PlannedStop[][] {
  const P = roles.length;
  const role = (p: number) => roles[p - 1] ?? "other";
  switch (archetype) {
    case "bouncer": {
      const pages = P >= 2 && r() < 0.4 ? [1, 2] : [1];
      return [pages.map((p) => stay(p, randInt(r, 2000, 9000)))];
    }
    case "skimmer": {
      const k = randInt(r, Math.ceil(0.6 * P), P);
      const stops: PlannedStop[] = [];
      for (let p = 1; p <= k; p++) {
        const flip = r() < Math.max(roleProfile(role(p)).skipBias, 0.3);
        stops.push(flip ? { page: p, ms: randInt(r, 300, 1400), flip: true } : stay(p, randInt(r, 2000, 8000)));
      }
      return [stops];
    }
    case "reader":
      return [roles.map((ro, i) => stay(i + 1, readerDwell(r, ro)))];
    case "jumper": {
      const stops = [stay(1, randInt(r, 4000, 10_000))];
      const pool = Array.from({ length: Math.max(0, P - 1) }, (_, i) => i + 2);
      const m = Math.min(randInt(r, 1, 3), pool.length);
      for (let i = 0; i < m; i++) {
        const idx = weightedIndex(r, pool.map((p) => roleProfile(role(p)).interest));
        const [page] = pool.splice(Math.max(0, idx), 1);
        stops.push(stay(page!, randInt(r, 20_000, 120_000)));
      }
      return [stops];
    }
    case "returner": {
      const k = Math.max(1, Math.ceil(uniform(r, 0.4, 0.7) * P));
      const first = Array.from({ length: Math.min(k, P) }, (_, i) => stay(i + 1, readerDwell(r, role(i + 1))));
      // `second` is the one scripted return visit earlier plans sent. It is no longer sent (buildPlan
      // swaps in `planReturnVisits`), but it is still drawn, injected and placed from the person's
      // stream: the first visit's slot, the intro and the download come after it in that stream, so
      // dropping these draws would move them for every returner of a seed that already exists.
      const second = [stay(1, randInt(r, 3000, 8000))];
      const tops = Array.from({ length: Math.max(0, P - 1) }, (_, i) => i + 2).sort(
        (a, b) => roleProfile(role(b)).interest - roleProfile(role(a)).interest || a - b,
      );
      const [top1, top2] = tops;
      if (top1 !== undefined) {
        second.push(stay(top1, randInt(r, 15_000, 90_000)));
        const away = top1 < P ? top1 + 1 : top1 - 1;
        second.push({ page: away, ms: randInt(r, 400, 1200), flip: true });
        second.push(stay(top1, randInt(r, 8000, 40_000)));
      }
      if (top2 !== undefined) second.push(stay(top2, randInt(r, 15_000, 60_000)));
      return [first, second];
    }
    case "stopper": {
      const stops: PlannedStop[] = [];
      for (let p = 1; p <= P; p++) {
        const prof = roleProfile(role(p));
        stops.push(stay(p, Math.min(240_000, Math.max(2000, uniform(r, 5000, 30_000) * prof.interest))));
        if (p < P && r() < prof.exitHazard) break;
      }
      return [stops];
    }
  }
}

function makeVisit(
  r: Rng,
  stops: PlannedStop[],
  ids: { visitId: string; rngSeed: number },
  opts: { injections: boolean },
): PlannedVisit {
  let hiddenSplit: PlannedVisit["hiddenSplit"] = null;
  let idle: PlannedVisit["idle"] = null;
  let killed = false;
  if (opts.injections) {
    const stays = stops.map((s, i) => ({ s, i })).filter(({ s }) => !s.flip && s.ms >= 4000);
    const hiddenRoll = r();
    const idleRoll = r();
    const killRoll = r();
    if (stays.length && hiddenRoll < 0.08) {
      const { s, i } = stays[Math.floor(r() * stays.length)]!;
      hiddenSplit = { stopIndex: i, afterMs: randInt(r, 1000, s.ms - 1000), gapMs: randInt(r, 30_000, 20 * MINUTE) };
    } else if (stays.length && idleRoll < 0.03) {
      const { s, i } = stays[Math.floor(r() * stays.length)]!;
      idle = { stopIndex: i, afterMs: randInt(r, 1000, s.ms - 1000), idleMs: randInt(r, 330_000, 15 * MINUTE) };
    }
    killed = killRoll < 0.06;
  }
  const durationMs = stops.reduce((a, s) => a + s.ms, 0) + (hiddenSplit?.gapMs ?? 0) + (idle?.idleMs ?? 0);
  return { visitId: ids.visitId, startAt: 0, durationMs, endAt: durationMs, stops, hiddenSplit, idle, killed, rngSeed: ids.rngSeed };
}

function place(v: PlannedVisit, startAt: number): void {
  v.startAt = Math.round(startAt);
  v.endAt = v.startAt + v.durationMs;
}

export const RETURN_STYLES = ["glance", "key_pages", "compare", "reread", "lingered", "pick_up", "appendix"] as const;
export type ReturnStyle = (typeof RETURN_STYLES)[number];

const KEY_INTEREST = 1.8;
const BACK_MATTER_ROLES = new Set(["appendix", "legal", "terms", "methodology"]);
const NY_WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" });

type ReturnContext = { roles: string[]; keys: number[]; back: number[] };

function returnContext(roles: string[]): ReturnContext {
  const pages = roles.map((role, i) => ({ role, page: i + 1 })).filter((x) => x.page > 1);
  return {
    roles,
    keys: pages.filter((x) => roleProfile(x.role).interest >= KEY_INTEREST).map((x) => x.page),
    back: pages.filter((x) => BACK_MATTER_ROLES.has(x.role)).map((x) => x.page),
  };
}

function pickStyle(r: Rng, ctx: ReturnContext, earlier: PlannedStop[], again: boolean): ReturnStyle {
  const P = ctx.roles.length;
  const exit = earlier[earlier.length - 1]?.page ?? 1;
  const k = ctx.keys.length;
  const b = ctx.back.length;
  const weights: Record<ReturnStyle, number> = again
    ? { glance: 0.3, key_pages: k ? 0.3 : 0, compare: k >= 2 ? 0.1 : 0, reread: 0.05, lingered: 0.2, pick_up: 0, appendix: b ? 0.1 : 0 }
    : { glance: 0.14, key_pages: k ? 0.22 : 0, compare: k >= 2 ? 0.1 : 0, reread: 0.14, lingered: 0.14, pick_up: exit < P ? 0.16 : 0, appendix: b ? 0.1 : 0 };
  return RETURN_STYLES[weightedIndex(r, RETURN_STYLES.map((s) => weights[s]))] ?? "glance";
}

/** Stops for one return visit. Every visit opens on page 1, because the viewer always does. */
function returnStops(style: ReturnStyle, ctx: ReturnContext, earlier: PlannedStop[], r: Rng, pace: number): PlannedStop[] {
  const P = ctx.roles.length;
  const role = (p: number) => ctx.roles[p - 1] ?? "other";
  const stops: PlannedStop[] = [];
  let at = 1;
  const add = (page: number, ms: number, flip = false) => {
    const prev = stops[stops.length - 1];
    if (prev && prev.page === page) {
      prev.ms += Math.round(ms);
      prev.flip = prev.flip && flip && prev.ms < 2000;
    } else {
      stops.push({ page, ms: Math.round(ms), flip });
    }
    at = page;
  };
  const clampMs = (ms: number) => Math.round(Math.min(240_000, Math.max(2000, ms)));
  const read = (p: number, scale = 1) => clampMs(readerDwell(r, role(p)) * pace * scale);
  const linger = (p: number) => clampMs(Math.max(8000, 30_000 * Math.exp(0.6 * normal(r)) * Math.sqrt(roleProfile(role(p)).interest) * pace));
  const brief = (lo: number, hi: number) => clampMs(uniform(r, lo, hi) * pace);
  const go = (to: number) => {
    const step = to > at ? 1 : -1;
    const distance = Math.abs(to - at);
    // Paging with the arrows shows every page in between for a moment; the thumbnail rail skips them.
    if (distance > 1 && distance <= 6 && r() < (step > 0 ? 0.35 : 0.2)) {
      for (let p = at + step; p !== to; p += step) add(p, randInt(r, 250, 900), true);
    }
  };
  const openCover = () => (r() < 0.3 ? add(1, randInt(r, 500, 1800), true) : add(1, randInt(r, 2000, 7000)));
  const pickKeys = (m: number) => {
    const pool = ctx.keys.slice();
    const out: number[] = [];
    for (let i = 0; i < m && pool.length; i++) {
      const idx = weightedIndex(r, pool.map((p) => roleProfile(role(p)).interest));
      out.push(...pool.splice(Math.max(0, idx), 1));
    }
    return out;
  };

  switch (style) {
    case "glance": {
      add(1, randInt(r, 3000, 15_000));
      if (P >= 2 && r() < 0.4) {
        const ms = randInt(r, 900, 8000);
        add(2, ms, ms < 2000);
      }
      break;
    }
    case "key_pages": {
      openCover();
      const picks = pickKeys(randInt(r, 1, Math.min(3, ctx.keys.length)));
      if (r() < 0.6) picks.sort((x, y) => x - y);
      for (const p of picks) {
        go(p);
        add(p, linger(p));
      }
      if (picks.length > 1 && r() < 0.25) {
        go(picks[0]!);
        add(picks[0]!, brief(5000, 30_000));
      }
      break;
    }
    case "compare": {
      openCover();
      const [a, b] = pickKeys(2) as [number, number];
      const rounds = randInt(r, 2, 3);
      for (let i = 0; i < rounds; i++) {
        go(a);
        add(a, i === 0 ? linger(a) : brief(4000, 25_000));
        go(b);
        add(b, i === 0 ? linger(b) : brief(4000, 25_000));
      }
      break;
    }
    case "reread": {
      const scale = uniform(r, 0.35, 0.7);
      add(1, randInt(r, 2000, 5000));
      for (let p = 2; p <= P; p++) {
        const prof = roleProfile(role(p));
        if (r() < prof.skipBias) add(p, randInt(r, 300, 1500), true);
        else add(p, read(p, scale));
        if (p < P && prof.interest >= KEY_INTEREST && r() < 0.15) break;
      }
      break;
    }
    case "lingered": {
      const byPage = new Map<number, number>();
      for (const s of earlier) if (s.page > 1) byPage.set(s.page, (byPage.get(s.page) ?? 0) + s.ms);
      const target = [...byPage.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0] ?? Math.min(2, P);
      openCover();
      if (target !== 1) {
        go(target);
        add(target, clampMs(linger(target) * uniform(r, 1, 1.6)));
      }
      const more = r() < 0.5 ? randInt(r, 1, 2) : 0;
      for (let i = 0; i < more && at < P; i++) add(at + 1, read(at + 1));
      break;
    }
    case "pick_up": {
      const exit = earlier[earlier.length - 1]?.page ?? 1;
      openCover();
      if (exit > 1) {
        go(exit);
        add(exit, randInt(r, 2500, 10_000));
      }
      for (let p = exit + 1; p <= P; p++) {
        add(p, read(p));
        if (p < P && r() < roleProfile(role(p)).exitHazard) break;
      }
      break;
    }
    case "appendix": {
      openCover();
      if (ctx.keys.length && r() < 0.4) {
        const [k] = pickKeys(1) as [number];
        go(k);
        add(k, linger(k));
      }
      for (const p of ctx.back.slice(0, 3)) {
        go(p);
        add(p, read(p, uniform(r, 1.2, 2.2)));
      }
      break;
    }
  }
  return stops;
}

/** Move `t` to a plausible New York hour on its day, mostly off weekends, kept inside [earliest, latest]. */
function returnTimeOfDay(r: Rng, t: number, earliest: number, latest: number): number {
  const roll = r();
  const minute = roll < 0.7 ? randInt(r, 8 * 60, 18 * 60 + 30) : roll < 0.9 ? randInt(r, 19 * 60, 23 * 60) : randInt(r, 6 * 60 + 30, 8 * 60);
  let out = t + (minute - nyMinuteOfDay(t)) * MINUTE;
  const weekday = NY_WEEKDAY.format(new Date(out));
  if ((weekday === "Sat" || weekday === "Sun") && r() < 0.75) out += (weekday === "Sat" ? 2 : 1) * DAY;
  if (out > latest) out -= Math.ceil((out - latest) / DAY) * DAY;
  return Math.round(Math.min(latest, Math.max(earliest, out)));
}

/**
 * A returner's later visits, from their own stream so they never move the person's first visit.
 * Each one comes back for something: a glance at the cover, straight to the pages that matter, a
 * back-and-forth between two of them, a faster re-read, the page they lingered on, picking up where
 * they stopped, or the back matter. The second visit is 12 hours to ~6 days after the first; a
 * quarter come back once more, from a couple of hours to three days later.
 */
export function planReturnVisits(a: { seed: number; tag: string; n: number; roles: string[]; first: PlannedVisit; runStart: number }): PlannedVisit[] {
  const r = rngFor(a.seed, `returns:${a.n}`);
  const ctx = returnContext(a.roles);
  const pace = Math.exp(0.3 * normal(r));
  const count = r() < 0.25 ? 2 : 1;
  const out: PlannedVisit[] = [];
  let prev = a.first;
  let earlier = a.first.stops;
  for (let i = 0; i < count; i++) {
    const again = i > 0;
    const vi = i + 2;
    const ids = { visitId: `v_seed_${a.tag}_${a.n}_${vi}`, rngSeed: hashString(`${a.seed}|visit|${a.n}|${vi}`) };
    const style = pickStyle(r, ctx, earlier, again);
    const stops = returnStops(style, ctx, earlier, r, pace);
    const gapRoll = r();
    const gap = again
      ? gapRoll < 0.5
        ? uniform(r, 2 * HOUR, 10 * HOUR)
        : uniform(r, 14 * HOUR, 3 * DAY)
      : gapRoll < 0.35
        ? uniform(r, 12 * HOUR, 36 * HOUR)
        : gapRoll < 0.75
          ? uniform(r, 36 * HOUR, 4 * DAY)
          : uniform(r, 4 * DAY, 6.2 * DAY);
    const earliest = prev.endAt + (again ? 2 * HOUR : 12 * HOUR);
    const latestFor = (v: PlannedVisit) => a.runStart - 20 * MINUTE - v.durationMs;
    let visit = makeVisit(r, stops, ids, { injections: true });
    if (latestFor(visit) < earliest) {
      // Too close to the run for this visit: a shorter one, without injections, or none at all.
      const trimmed = stops.slice();
      while (trimmed.length > 1 && a.runStart - 20 * MINUTE - trimmed.reduce((x, s) => x + s.ms, 0) < earliest) trimmed.pop();
      visit = makeVisit(r, trimmed, ids, { injections: false });
      if (latestFor(visit) < earliest && again) break;
    }
    const latest = latestFor(visit);
    // A gap that overshoots the run is redrawn inside the window, not clamped: clamping piles every
    // late returner onto the run's last day.
    const target = prev.endAt + gap <= latest ? prev.endAt + gap : uniform(r, earliest, latest);
    const start = latest < earliest ? latest : returnTimeOfDay(r, target, earliest, latest);
    place(visit, start);
    visit.returnStyle = style;
    out.push(visit);
    prev = visit;
    earlier = [...earlier, ...visit.stops];
  }
  return out;
}

function drawFirstStart(r: Rng, earliest: number, latest: number, runStart: number): number {
  for (let i = 0; i < 5; i++) {
    let t = earliest - Math.log(1 - r()) * 30 * HOUR;
    if (r() < 0.8) t = intoWorkHours(r, t);
    if (t <= latest) return Math.round(t);
  }
  const fallback = runStart - uniform(r, 20 * MINUTE, 600 * MINUTE);
  return Math.round(Math.max(earliest + MINUTE, Math.min(fallback, latest)));
}

function bucketRanges(count: number, smoke: boolean): Array<[number, number]> {
  if (smoke) return Array.from({ length: count }, () => [5, 15] as [number, number]);
  const ranges: Array<[number, number]> = [];
  const add = (n: number, lo: number, hi: number) => {
    for (let i = 0; i < n; i++) ranges.push([lo, hi]);
  };
  add(2, 0, 0);
  add(3, 1, 1);
  add(12, 2, 4);
  add(20, 5, 15);
  add(8, 16, 29);
  add(5, 30, 45);
  while (ranges.length < count) ranges.push([5, 15]);
  return ranges.slice(0, count);
}

function planDocs(input: PlanInput, smoke: boolean): PlannedDoc[] {
  const r = rngFor(input.seed, "docs");
  const order = shuffle(r, input.docs.map((_, i) => i));
  const ranges = bucketRanges(input.docs.length, smoke);
  const bucketOf = new Map<number, [number, number]>();
  order.forEach((docIndex, k) => bucketOf.set(docIndex, ranges[k]!));

  return input.docs.map((d, i) => {
    const rd = rngFor(input.seed, `doc:${d.docId}`);
    const [lo, hi] = bucketOf.get(i)!;
    const people = randInt(rd, lo, hi);
    const createdAt = Math.round(input.runStart - uniform(rd, 3 * DAY, 26 * DAY));
    const labelled = shuffle(
      rd,
      d.links.filter((l) => !l.isDefault),
    );
    const zero = people >= 5 ? Math.min(randInt(rd, 1, 2), Math.max(0, labelled.length - 1)) : 0;
    const weights = labelled.map((_, rank) => (rank >= labelled.length - zero ? 0 : 1 / Math.pow(rank + 1, 1.1)));
    const nonZero = weights.filter((w) => w > 0);
    const links: PlannedLink[] = labelled.map((l, k) => ({
      ...l,
      createdAt: Math.round(createdAt + uniform(rd, 0, 36 * HOUR)),
      weight: weights[k]!,
    }));
    for (const l of d.links.filter((x) => x.isDefault)) {
      links.push({ ...l, createdAt, weight: nonZero.length ? 0.3 * Math.min(...nonZero) : 1 });
    }
    return {
      docId: d.docId,
      slug: d.slug,
      roles: d.pages,
      pageCount: d.pages.length,
      createdAt,
      bucket: `${lo}-${hi}`,
      people,
      links,
    };
  });
}

function archetypeQuota(r: Rng, total: number): Archetype[] {
  const entries = Object.entries(ARCHETYPE_SHARES) as Array<[Archetype, number]>;
  const raw = entries.map(([a, s]) => ({ a, exact: s * total, n: Math.floor(s * total) }));
  let left = total - raw.reduce((x, y) => x + y.n, 0);
  for (const e of raw.slice().sort((x, y) => y.exact - y.n - (x.exact - x.n))) {
    if (left <= 0) break;
    e.n += 1;
    left -= 1;
  }
  return shuffle(
    r,
    raw.flatMap((e) => Array.from({ length: e.n }, () => e.a)),
  );
}

function personMaxEnd(p: PlannedPerson): number {
  return Math.max(...p.visits.map((v) => v.endAt), p.download?.atMs ?? 0);
}

export function isLinkActiveAt(l: Pick<PlanLink, "enabled" | "archivedAt" | "expiresAt">, now: number): boolean {
  if (l.enabled === false) return false;
  if (l.archivedAt) return false;
  if (l.expiresAt !== null && l.expiresAt !== undefined) {
    const t = typeof l.expiresAt === "number" ? l.expiresAt : Date.parse(l.expiresAt);
    if (!Number.isFinite(t) || t <= now) return false;
  }
  return true;
}

export type LinkState = Record<string, Pick<PlanLink, "enabled" | "archivedAt" | "expiresAt">>;

/** Zipf-weighted pick among links that are active after the fix-up (never refused, archived, disabled or expiring). */
export function pickLiveLink(
  r: Rng,
  doc: PlannedDoc,
  refused: ReadonlySet<string>,
  now: number,
  linkState?: LinkState,
  exclude?: ReadonlySet<string>,
): PlannedLink | null {
  const eligible = doc.links.filter((l) => {
    if (refused.has(l.shareId) || exclude?.has(l.shareId)) return false;
    const state = linkState?.[l.shareId] ?? l;
    return isLinkActiveAt(state, now) && (state.expiresAt === null || state.expiresAt === undefined);
  });
  if (!eligible.length) return null;
  const idx = weightedIndex(
    r,
    eligible.map((l) => l.weight),
  );
  return eligible[idx >= 0 ? idx : Math.floor(r() * eligible.length)]!;
}

/**
 * One live-tail batch: 10 people on 3 docs with at least 5 bulk people, each visit ending within
 * 9 minutes before it is sent. Batch 0 is part of the main run; later batches are `--live-only` reruns.
 */
export function planLiveTail(
  plan: Pick<Plan, "tag" | "seed" | "docs" | "people" | "refusedShareIds"> & { live?: PlannedPerson[] },
  opts: { batch: number; now: number; linkState?: LinkState },
): { people: PlannedPerson[]; skipped: string | null } {
  const eligibleDocs = plan.docs.filter((d) => d.people >= 5);
  if (eligibleDocs.length < 3) {
    return { people: [], skipped: `skipped: live tail (needs 3 docs, have ${eligibleDocs.length})` };
  }
  const r = rngFor(plan.seed, `live:${opts.batch}`);
  const refused = new Set(plan.refusedShareIds);
  const chosen = shuffle(r, eligibleDocs);
  const perDoc = [4, 3, 3];
  const people: PlannedPerson[] = [];
  let i = 0;
  let docCursor = 0;
  for (let slot = 0; slot < perDoc.length && docCursor < chosen.length; docCursor++) {
    const doc = chosen[docCursor]!;
    if (!pickLiveLink(rngFor(plan.seed, `live-probe:${doc.docId}`), doc, refused, opts.now, opts.linkState)) continue;
    const used = new Set(
      [...plan.people, ...(plan.live ?? [])].filter((p) => p.docId === doc.docId && p.intro).map((p) => p.intro!.viewerName),
    );
    for (let k = 0; k < perDoc[slot]!; k++, i++) {
      const n = (opts.batch + 1) * 100_000 + i;
      const rp = rngFor(plan.seed, `live-person:${opts.batch}:${i}`);
      const link = pickLiveLink(rp, doc, refused, opts.now, opts.linkState)!;
      const archetype = (["reader", "jumper", "skimmer", "stopper"] as const)[weightedIndex(rp, [0.25, 0.15, 0.25, 0.08])]!;
      let stops = buildStops(archetype, doc.roles, rp)[0]!.map((s) => (s.flip ? s : { ...s, ms: Math.min(s.ms, 60_000) }));
      while (stops.length > 1 && stops.reduce((a, s) => a + s.ms, 0) > 8 * MINUTE) stops = stops.slice(0, -1);
      const visit = makeVisit(rp, stops, { visitId: `v_seed_${plan.tag}_${n}_1`, rngSeed: hashString(`${plan.seed}|visit|${n}|1`) }, { injections: false });
      const endsAgoMs = randInt(rp, 5000, Math.max(5000, 9 * MINUTE - visit.durationMs));
      place(visit, opts.now - endsAgoMs - visit.durationMs);
      people.push({
        n,
        botId: botIdFor(plan.tag, n),
        docId: doc.docId,
        slug: doc.slug,
        shareId: link.shareId,
        linkLabel: link.label,
        archetype,
        ip: ipFor(n),
        intro: rp() < 0.3 ? pickIntro(rp, used, link.label) : null,
        visits: [visit],
        download: null,
        live: true,
        batch: opts.batch,
        ownerPreview: false,
        endsAgoMs,
      });
    }
    slot += 1;
  }
  return { people, skipped: people.length ? null : "skipped: live tail (no active links on eligible docs)" };
}

export function buildPlan(input: PlanInput): Plan {
  const smoke = input.smoke ?? input.docs.length < 50;
  const { runStart, seed, tag } = input;
  const skipped: string[] = [];
  const docs = planDocs(input, smoke);
  const docOrder = shuffle(rngFor(seed, "people-order"), docs);
  const total = docs.reduce((a, d) => a + d.people, 0);
  const quota = archetypeQuota(rngFor(seed, "archetypes"), total);

  const people: PlannedPerson[] = [];
  let n = 0;
  for (const doc of docOrder) {
    const usedNames = new Set<string>();
    for (let k = 0; k < doc.people; k++) {
      n += 1;
      const rp = rngFor(seed, `person:${n}`);
      const linkIdx = weightedIndex(
        rp,
        doc.links.map((l) => l.weight),
      );
      const link = doc.links[Math.max(0, linkIdx)]!;
      const archetype = quota[n - 1]!;
      const stopSets = buildStops(archetype, doc.roles, rp);
      const visits = stopSets.map((stops, vi) =>
        makeVisit(rp, stops, { visitId: `v_seed_${tag}_${n}_${vi + 1}`, rngSeed: hashString(`${seed}|visit|${n}|${vi + 1}`) }, { injections: true }),
      );
      const [v1, v2] = visits;
      const reserve = v2 ? 12 * HOUR + v2.durationMs + 20 * MINUTE : 20 * MINUTE;
      const latest = Math.min(runStart - 20 * MINUTE, runStart - reserve - v1!.durationMs - MINUTE);
      place(v1!, drawFirstStart(rp, link.createdAt, latest, runStart));
      if (v2) {
        const latest2 = runStart - 20 * MINUTE - v2.durationMs;
        let start2 = -1;
        for (let i = 0; i < 5; i++) {
          const t = v1!.endAt + uniform(rp, 12 * HOUR, 7 * DAY);
          if (t <= latest2) {
            start2 = t;
            break;
          }
        }
        if (start2 < 0) start2 = v1!.endAt + 12 * HOUR + uniform(rp, 0, Math.max(0, latest2 - (v1!.endAt + 12 * HOUR)));
        place(v2, start2);
      }
      const downloadDelay = link.allowDownload && rp() < 0.3 ? uniform(rp, 20_000, 10 * MINUTE) : null;
      const intro = rp() < 0.3 ? pickIntro(rp, usedNames, link.label) : null;
      if (archetype === "returner") {
        visits.splice(1, visits.length - 1, ...planReturnVisits({ seed, tag, n, roles: doc.roles, first: v1!, runStart }));
      }
      const last = visits[visits.length - 1]!;
      const download = downloadDelay === null ? null : { atMs: Math.round(Math.min(runStart - MINUTE, last.endAt + downloadDelay)) };
      people.push({
        n,
        botId: botIdFor(tag, n),
        docId: doc.docId,
        slug: doc.slug,
        shareId: link.shareId,
        linkLabel: link.label,
        archetype,
        ip: ipFor(n),
        intro,
        visits,
        download,
        live: false,
        batch: null,
        ownerPreview: false,
        endsAgoMs: null,
      });
    }
  }

  const ownerPreviews: PlannedPerson[] = [];
  if (docs.length >= 3) {
    const ro = rngFor(seed, "owner");
    shuffle(ro, docs)
      .slice(0, 3)
      .forEach((doc, di) => {
        const link = doc.links.find((l) => l.isDefault) ?? doc.links[0]!;
        for (let k = 0; k < 2; k++) {
          const on = 900_000 + di * 2 + k;
          const pages = Math.min(doc.pageCount, randInt(ro, 2, 4));
          const stops = Array.from({ length: pages }, (_, i) => stay(i + 1, randInt(ro, 3000, 15_000)));
          const visit = makeVisit(ro, stops, { visitId: `v_seed_${tag}_${on}_1`, rngSeed: hashString(`${seed}|visit|${on}|1`) }, { injections: false });
          place(visit, Math.min(doc.createdAt + uniform(ro, 10 * MINUTE, 3 * HOUR), runStart - HOUR - visit.durationMs));
          ownerPreviews.push({
            n: on,
            botId: botIdFor(tag, on),
            docId: doc.docId,
            slug: doc.slug,
            shareId: link.shareId,
            linkLabel: link.label,
            archetype: "reader",
            ip: ipFor(on),
            intro: null,
            visits: [visit],
            download: null,
            live: false,
            batch: null,
            ownerPreview: true,
            endsAgoMs: null,
          });
        }
      });
  } else {
    skipped.push(`skipped: owner previews (needs 3 docs, have ${docs.length})`);
  }

  const refused: RefusedLink[] = [];
  {
    const rr = rngFor(seed, "refused");
    const candidatesByDoc = docs
      .filter((d) => d.people >= 5)
      .map((d) => {
        const onDoc = people.filter((p) => p.docId === d.docId);
        const links = d.links
          .filter((l) => !l.isDefault)
          .map((l) => {
            const ps = onDoc.filter((p) => p.shareId === l.shareId);
            return { link: l, count: ps.length, maxEnd: ps.length ? Math.max(...ps.map(personMaxEnd)) : 0 };
          })
          .filter((c) => c.count >= 1 && c.maxEnd <= runStart - 3 * HOUR);
        return { doc: d, links };
      })
      .filter((c) => c.links.length > 0);
    if (candidatesByDoc.length < 6 && smoke) {
      skipped.push(`skipped: refused links (needs 6 docs, have ${candidatesByDoc.length})`);
    } else {
      if (candidatesByDoc.length < 6) skipped.push(`refused links: only ${candidatesByDoc.length} of 6 docs eligible`);
      shuffle(rr, candidatesByDoc)
        .slice(0, 6)
        .forEach((c, i) => {
          const pick = c.links[Math.floor(rr() * c.links.length)]!;
          const disableAt = Math.round(Math.min(pick.maxEnd + uniform(rr, HOUR, 2 * DAY), runStart - MINUTE));
          refused.push({
            docId: c.doc.docId,
            shareId: pick.link.shareId,
            label: pick.link.label,
            kind: i < 3 ? "disabled" : "expired",
            maxEnd: pick.maxEnd,
            disableAt,
          });
        });
    }
  }
  const refusedShareIds = refused.map((x) => x.shareId);

  const base = { tag, seed, docs, people, refusedShareIds };
  const liveTail = planLiveTail(base, { batch: 0, now: runStart });
  if (liveTail.skipped) skipped.push(liveTail.skipped);

  return {
    tag,
    seed,
    runStart,
    smoke,
    docs,
    people,
    ownerPreviews,
    refused,
    refusedShareIds,
    live: liveTail.people,
    skipped,
  };
}
