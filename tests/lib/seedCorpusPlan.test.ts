import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DOC_SPECS, TYPE_COUNTS, TYPE_PAGES } from "../share/seed-corpus/content";
import {
  ARCHETYPE_SHARES,
  buildPlan,
  DAY,
  HOUR,
  isLinkActiveAt,
  MINUTE,
  planLiveTail,
  type Archetype,
  type Plan,
  type PlanDocInput,
  type PlannedPerson,
} from "../share/seed-corpus/plan";
import { compilePerson, compileVisit, type WireRequest } from "../share/seed-corpus/wire";

const RUN_START = Date.parse("2026-09-16T15:00:00.000Z");
const TAG = "sctest0000";

function corpusInput(count = DOC_SPECS.length): PlanDocInput[] {
  return DOC_SPECS.slice(0, count).map((spec, i) => {
    const docId = `6ab0000000000000000${String(i).padStart(5, "0")}`;
    return {
      slug: spec.slug,
      docId,
      pages: spec.pages.map((p) => p.role),
      links: [
        { shareId: `def${String(i).padStart(4, "0")}xx`, label: "Default link", isDefault: true, allowDownload: false },
        ...spec.links.map((l, k) => ({
          shareId: `lnk${String(i).padStart(3, "0")}${k}xx`,
          label: l.label,
          isDefault: false,
          allowDownload: l.allowDownload,
        })),
      ],
    };
  });
}

function build(seed = 42, count?: number): Plan {
  return buildPlan({ tag: TAG, seed, runStart: RUN_START, docs: corpusInput(count) });
}

const plan = build();
const docById = new Map(plan.docs.map((d) => [d.docId, d]));
const allPeople: PlannedPerson[] = [...plan.people, ...plan.ownerPreviews, ...plan.live];

function requestsOf(p: PlannedPerson): WireRequest[] {
  return compilePerson(p, docById.get(p.docId)!.pageCount).flat();
}

describe("seed corpus content", () => {
  it("has 50 specs with type counts and page ranges from the spec", () => {
    expect(DOC_SPECS).toHaveLength(50);
    for (const [type, count] of TYPE_COUNTS) expect(DOC_SPECS.filter((d) => d.type === type)).toHaveLength(count);
    for (const d of DOC_SPECS) {
      const [lo, hi] = TYPE_PAGES[d.type];
      expect(d.pages.length).toBeGreaterThanOrEqual(lo);
      expect(d.pages.length).toBeLessThanOrEqual(hi);
      expect(new Set(d.pages.map((p) => p.heading)).size).toBe(d.pages.length);
      expect(d.links.length).toBeGreaterThanOrEqual(5);
      expect(d.links.length).toBeLessThanOrEqual(10);
      expect(d.summary.length).toBeGreaterThanOrEqual(40);
      expect(d.summary.length).toBeLessThanOrEqual(600);
      expect(d.keyPoints.every((k) => k.length <= 160)).toBe(true);
    }
  });
});

describe("seed corpus plan (seed 42)", () => {
  it("is deterministic", () => {
    const again = build();
    expect(again).toEqual(plan);
    const p = plan.people[7]!;
    expect(requestsOf(again.people[7]!)).toEqual(requestsOf(p));
  });

  it("assigns the people buckets 2/3/12/20/8/5", () => {
    const count = (lo: number, hi: number) => plan.docs.filter((d) => d.people >= lo && d.people <= hi).length;
    expect([count(0, 0), count(1, 1), count(2, 4), count(5, 15), count(16, 29), count(30, 45)]).toEqual([2, 3, 12, 20, 8, 5]);
    for (const d of plan.docs) expect(plan.people.filter((p) => p.docId === d.docId)).toHaveLength(d.people);
  });

  it("keeps every visit inside [link createdAt, runStart]", () => {
    for (const p of allPeople.filter((x) => !x.live)) {
      const link = docById.get(p.docId)!.links.find((l) => l.shareId === p.shareId)!;
      for (const v of p.visits) {
        expect(v.startAt).toBeGreaterThanOrEqual(link.createdAt);
        expect(v.endAt).toBeLessThanOrEqual(RUN_START);
        expect(v.endAt).toBe(v.startAt + v.durationMs);
      }
      if (p.download) expect(p.download.atMs).toBeLessThanOrEqual(RUN_START);
    }
  });

  it("brings a returner back 12h to ~6 days later, and any third visit at least 2h after that", () => {
    const returners = plan.people.filter((p) => p.visits.length >= 2);
    expect(returners.length).toBeGreaterThan(0);
    expect(returners.length).toBe(plan.people.filter((p) => p.archetype === "returner").length);
    for (const p of returners) {
      expect(p.archetype).toBe("returner");
      expect(p.visits.length).toBeLessThanOrEqual(3);
      expect(p.visits[1]!.startAt - p.visits[0]!.endAt).toBeGreaterThanOrEqual(12 * HOUR);
      expect(p.visits[1]!.startAt - p.visits[0]!.endAt).toBeLessThanOrEqual(8 * DAY);
      if (p.visits[2]) expect(p.visits[2].startAt - p.visits[1]!.endAt).toBeGreaterThanOrEqual(2 * HOUR);
    }
  });

  it("varies return visits by what the person came back for", () => {
    const returners = plan.people.filter((p) => p.archetype === "returner");
    const later = returners.flatMap((p) => p.visits.slice(1).map((v) => ({ p, v })));
    const styles = new Map<string, number>();
    for (const { v } of later) styles.set(v.returnStyle!, (styles.get(v.returnStyle!) ?? 0) + 1);
    expect(styles.size).toBeGreaterThanOrEqual(5);
    for (const n of styles.values()) expect(n / later.length).toBeLessThanOrEqual(0.4);
    expect(returners.some((p) => p.visits.length === 3)).toBe(true);

    const gaps = returners.map((p) => p.visits[1]!.startAt - p.visits[0]!.endAt);
    expect(gaps.some((g) => g < 36 * HOUR)).toBe(true);
    expect(gaps.some((g) => g > 4 * DAY)).toBe(true);

    // The old script: cover, jump, flick one page on, flick back. No longer the shape of most returns.
    const paths = later.map(({ v }) => v.stops.map((s) => s.page).join(">"));
    expect(new Set(paths).size / later.length).toBeGreaterThanOrEqual(0.5);
    const lengths = new Set(later.map(({ v }) => v.stops.length));
    expect(lengths.size).toBeGreaterThanOrEqual(5);

    for (const { p, v } of later) {
      const roles = docById.get(p.docId)!.roles;
      expect(v.stops[0]!.page).toBe(1);
      for (let i = 1; i < v.stops.length; i++) expect(v.stops[i]!.page).not.toBe(v.stops[i - 1]!.page);
      for (const s of v.stops) expect(s.ms).toBeLessThanOrEqual(240_000);
      const longest = v.stops.reduce((a, s) => (s.ms > a.ms ? s : a));
      if (v.returnStyle === "key_pages" || v.returnStyle === "compare") {
        expect(roles[longest.page - 1]).toMatch(/^(pricing|financials|ask|team|traction|metrics|options|roi|compliance)$/);
      }
      if (v.returnStyle === "appendix") {
        expect(v.stops.some((s) => /^(appendix|legal|terms|methodology)$/.test(roles[s.page - 1]!))).toBe(true);
      }
      if (v.returnStyle === "glance") expect(v.stops.length).toBeLessThanOrEqual(2);
    }
  });

  it("keeps first visits, intros and link picks where the single-script planner put them", () => {
    // Return visits draw from their own stream; this digest was taken before they did, so a change
    // that shifts the person stream (and so every existing seed's first visits) fails here.
    const digest = createHash("sha256")
      .update(JSON.stringify(plan.people.map((p) => [p.n, p.shareId, p.archetype, p.intro, p.visits[0]!.startAt, p.visits[0]!.endAt, p.visits[0]!.stops, !!p.download])))
      .digest("hex")
      .slice(0, 16);
    expect(digest).toBe("da0338546192540c");
  });

  it("produces valid timing payloads: durations >= 1, enteredAtMs < leftAtMs, page time <= visit time", () => {
    let posts = 0;
    for (const p of allPeople) {
      const d = docById.get(p.docId)!;
      for (const v of p.visits) {
        const { requests } = compileVisit(v, { botId: p.botId, shareId: p.shareId, numPages: d.pageCount, intro: p.intro });
        posts += requests.length;
        let visitMs = 0;
        let pageMs = 0;
        for (const req of requests) {
          const b = req.body!;
          expect(b.tv).toBe(2);
          expect(b.numPages).toBe(d.pageCount);
          if (req.kind !== "timing") continue;
          if ("durationMs" in b) {
            expect(b.durationMs as number).toBeGreaterThanOrEqual(1);
            visitMs += b.durationMs as number;
          }
          if ("pageDurationMs" in b) {
            expect(b.pageDurationMs as number).toBeGreaterThanOrEqual(1);
            // Bounds only on an exit. A heartbeat reports the page the reader is still on — that is
            // what gives a one-page document any per-page time at all — and sending bounds with it
            // would tell the server they had left (`isPageExit`).
            if ("enteredAtMs" in b) expect(b.enteredAtMs as number).toBeLessThan(b.leftAtMs as number);
            else expect("leftAtMs" in b).toBe(false);
            expect(b.pageNumber as number).toBeGreaterThanOrEqual(1);
            expect(b.pageNumber as number).toBeLessThanOrEqual(d.pageCount);
            pageMs += b.pageDurationMs as number;
          }
        }
        expect(pageMs).toBeLessThanOrEqual(visitMs);
      }
    }
    expect(posts).toBeGreaterThan(5000);
  });

  it("leaves >= 15 docs with a zero-people non-default link at least 48h old", () => {
    const docs = plan.docs.filter((d) =>
      d.links.some(
        (l) => !l.isDefault && RUN_START - l.createdAt >= 48 * HOUR && !plan.people.some((p) => p.shareId === l.shareId),
      ),
    );
    expect(docs.length).toBeGreaterThanOrEqual(15);
  });

  it("(m) refuses 6 links, each with people, and disables them after their last visit and before runStart - 1min", () => {
    expect(plan.refused).toHaveLength(6);
    expect(plan.refused.filter((r) => r.kind === "disabled")).toHaveLength(3);
    expect(new Set(plan.refused.map((r) => r.docId)).size).toBe(6);
    for (const r of plan.refused) {
      const ps = plan.people.filter((p) => p.shareId === r.shareId);
      expect(ps.length).toBeGreaterThanOrEqual(1);
      const maxEnd = Math.max(...ps.flatMap((p) => [...p.visits.map((v) => v.endAt), p.download?.atMs ?? 0]));
      expect(maxEnd).toBe(r.maxEnd);
      expect(maxEnd).toBeLessThan(r.disableAt);
      expect(r.disableAt).toBeLessThanOrEqual(RUN_START - 60_000);
      expect(docById.get(r.docId)!.links.find((l) => l.shareId === r.shareId)!.isDefault).toBe(false);
    }
    expect(plan.refusedShareIds).toEqual(plan.refused.map((r) => r.shareId));
  });

  it("(n) sends the live tail only through links that stay active", () => {
    expect(plan.live).toHaveLength(10);
    expect(new Set(plan.live.map((p) => p.docId)).size).toBe(3);
    const refused = new Set(plan.refusedShareIds);
    for (const p of plan.live) {
      expect(refused.has(p.shareId)).toBe(false);
      const link = docById.get(p.docId)!.links.find((l) => l.shareId === p.shareId)!;
      expect(isLinkActiveAt(link, RUN_START)).toBe(true);
      expect(link.expiresAt ?? null).toBeNull();
      expect(docById.get(p.docId)!.people).toBeGreaterThanOrEqual(5);
      expect(p.visits[0]!.durationMs + p.endsAgoMs!).toBeLessThanOrEqual(9 * MINUTE);
    }
  });

  it("(o) a live-only plan at runStart+2h still excludes refused links, and honours link state read back", () => {
    const now = RUN_START + 2 * HOUR;
    const rerun = planLiveTail(plan, { batch: 1, now });
    expect(rerun.people).toHaveLength(10);
    const refused = new Set(plan.refusedShareIds);
    for (const p of rerun.people) expect(refused.has(p.shareId)).toBe(false);
    expect(new Set(rerun.people.map((p) => p.botId)).size).toBe(10);
    expect(rerun.people.some((p) => plan.live.some((q) => q.botId === p.botId))).toBe(false);

    const disabledNow = rerun.people[0]!.shareId;
    const withState = planLiveTail(plan, { batch: 1, now, linkState: { [disabledNow]: { enabled: false, archivedAt: null, expiresAt: null } } });
    expect(withState.people.some((p) => p.shareId === disabledNow)).toBe(false);
  });

  it("keeps archetype shares within 4 points", () => {
    const total = plan.people.length;
    for (const [a, share] of Object.entries(ARCHETYPE_SHARES) as Array<[Archetype, number]>) {
      const actual = plan.people.filter((p) => p.archetype === a).length / total;
      expect(Math.abs(actual - share)).toBeLessThanOrEqual(0.04);
    }
  });

  it("gives all-flip skimmer visits no stayed page beyond their final segment", () => {
    const stayedPages = (p: PlannedPerson, v: PlannedPerson["visits"][number]) =>
      compileVisit(v, { botId: p.botId, shareId: p.shareId, numPages: docById.get(p.docId)!.pageCount, intro: p.intro })
        .requests.filter((r) => r.kind === "timing" && "pageDurationMs" in r.body! && r.body!.reason !== "pagehide")
        .filter((r) => (r.body!.pageDurationMs as number) >= 2000)
        .map((r) => r.body!.pageNumber as number);

    const skimmer = plan.people.find((x) => x.archetype === "skimmer" && x.visits[0]!.stops.length >= 6)!;
    const v = skimmer.visits[0]!;
    const allFlip = { ...v, stops: v.stops.map((s, i) => ({ page: s.page, ms: 300 + i * 100, flip: true })), hiddenSplit: null, idle: null, killed: false };
    allFlip.durationMs = allFlip.stops.reduce((a, s) => a + s.ms, 0);
    allFlip.endAt = allFlip.startAt + allFlip.durationMs;
    expect(stayedPages(skimmer, allFlip)).toEqual([]);

    for (const p of plan.people.filter((x) => x.archetype === "skimmer")) {
      for (const visit of p.visits) {
        const stayPages = new Set(visit.stops.filter((s) => !s.flip).map((s) => s.page));
        for (const page of stayedPages(p, visit)) expect(stayPages.has(page)).toBe(true);
      }
    }
  });

  it("never plans a request to an email-sending path", () => {
    for (const p of allPeople) {
      for (const req of requestsOf(p)) {
        expect(req.path).not.toMatch(/download-requests|invite|\/api\/cron\//);
        if (req.method === "GET") expect(req.path).toMatch(/^\/s\/[^/]+\/pdf\?download=1&botId=/);
        else expect(req.path).toMatch(/^\/api\/share\/[^/]+\/stats$/);
      }
    }
  });

  it("uses unique botIds and marks owner previews apart from people", () => {
    const ids = allPeople.map((p) => p.botId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith(`b_seed_${TAG}_`))).toBe(true);
    expect(plan.ownerPreviews).toHaveLength(6);
    expect(plan.ownerPreviews.every((p) => p.ownerPreview)).toBe(true);
    expect(plan.people.some((p) => p.ownerPreview)).toBe(false);
  });

  it("smoke profile with one doc: >= 5 people, >= 1 visit, refused and live steps skipped", () => {
    const smoke = build(42, 1);
    expect(smoke.smoke).toBe(true);
    expect(smoke.people.length).toBeGreaterThanOrEqual(5);
    expect(smoke.people.flatMap((p) => p.visits).length).toBeGreaterThanOrEqual(1);
    expect(smoke.refused).toHaveLength(0);
    expect(smoke.live).toHaveLength(0);
    expect(smoke.skipped.some((s) => s.startsWith("skipped: refused links"))).toBe(true);
    expect(smoke.skipped.some((s) => s.startsWith("skipped: live tail"))).toBe(true);
  });

  it("places docs 3-26 days before runStart and links within 36h of their doc", () => {
    for (const d of plan.docs) {
      expect(RUN_START - d.createdAt).toBeGreaterThanOrEqual(3 * DAY);
      expect(RUN_START - d.createdAt).toBeLessThanOrEqual(26 * DAY);
      for (const l of d.links) {
        expect(l.createdAt - d.createdAt).toBeGreaterThanOrEqual(0);
        expect(l.createdAt - d.createdAt).toBeLessThanOrEqual(36 * HOUR);
      }
    }
  });
});
