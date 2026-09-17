import { describe, expect, test } from "vitest";

import {
  ACTIVITY_SUMMARY_BUCKETS,
  ACTIVITY_WORK_TYPES,
  bucketForType,
  groupActorSlices,
  buildActivitySeries,
  summarizeActivityRows,
  type ActivityGroupRow,
} from "@/lib/activity/summary";

const row = (type: string, count: number, client: string | null = null, label: string | null = null): ActivityGroupRow => ({
  type,
  client,
  label,
  count,
});

describe("activity summary buckets", () => {
  test("a new document is doc.created, not the upload or the import", () => {
    expect(bucketForType("doc.created")).toBe("docsAdded");
    // Both would double-count: upload.completed fires again for every replacement, and
    // doc.imported_url is the same arrival seen from the agent path.
    expect(bucketForType("upload.completed")).toBeNull();
    expect(bucketForType("doc.imported_url")).toBeNull();
    expect(ACTIVITY_WORK_TYPES).not.toContain("upload.completed");
    expect(ACTIVITY_WORK_TYPES).not.toContain("doc.imported_url");
  });

  test("archive and delete share one count; replacements and links have their own", () => {
    expect(bucketForType("doc.archived")).toBe("docsRemoved");
    expect(bucketForType("doc.deleted")).toBe("docsRemoved");
    expect(bucketForType("doc.replaced")).toBe("docsReplaced");
    expect(bucketForType("share_link.created")).toBe("linksCreated");
    expect(bucketForType("project.created")).toBe("projectsCreated");
  });

  test("performance types never reach the header — they belong to the metrics page", () => {
    for (const t of ["share.viewed", "share.downloaded", "download_request.created"]) {
      expect(ACTIVITY_WORK_TYPES).not.toContain(t);
      expect(bucketForType(t)).toBeNull();
    }
    // The pipeline is not a person acting, either.
    expect(ACTIVITY_WORK_TYPES).not.toContain("doc.processed");
  });

  test("every bucket's types are work types, so a tile can never outgrow the donut's total", () => {
    for (const b of ACTIVITY_SUMMARY_BUCKETS) {
      for (const t of b.types) expect(ACTIVITY_WORK_TYPES).toContain(t);
    }
  });

  test("changes that are not arrivals still count as work", () => {
    for (const t of ["share_link.updated", "share_link.revoked", "share.updated", "doc.added_to_project", "project.deleted"]) {
      expect(ACTIVITY_WORK_TYPES).toContain(t);
      // …but they have no tile of their own; they only feed the donut.
      expect(bucketForType(t)).toBeNull();
    }
  });

  test("counts add across types and actors, ignoring anything outside the work list", () => {
    const summary = summarizeActivityRows([
      row("doc.created", 3),
      row("doc.created", 2, "claude-code", "Claude Code"),
      row("doc.archived", 1),
      row("doc.deleted", 2),
      row("share.viewed", 999),
      row("upload.completed", 40),
    ]);
    expect(summary.counts).toEqual({ docsAdded: 5, docsReplaced: 0, linksCreated: 0, docsRemoved: 3, projectsCreated: 0 });
    // Views and uploads are excluded from the donut's total as well as from the tiles.
    expect(summary.actors.total).toBe(8);
  });
});

describe("actor grouping", () => {
  test("rows without an agent are the people slice; agent clients get their own", () => {
    const actors = groupActorSlices([
      row("doc.created", 4),
      row("share_link.created", 1),
      row("doc.replaced", 6, "claude-code", "Claude Code"),
      row("doc.created", 2, "cursor", "Cursor"),
    ]);
    expect(actors.people).toBe(5);
    expect(actors.agents).toBe(8);
    expect(actors.total).toBe(13);
    expect(actors.slices.map((s) => [s.key, s.count])).toEqual([
      ["people", 5],
      ["agent:claude-code", 6],
      ["agent:cursor", 2],
    ]);
    expect(actors.slices[0]?.kind).toBe("people");
    expect(actors.slices[1]?.label).toBe("Claude Code");
  });

  test("one client's rows across several types are one slice", () => {
    const actors = groupActorSlices([
      row("doc.created", 1, "claude-code", "Claude Code"),
      row("doc.replaced", 2, "claude-code", "Claude Code"),
      row("share_link.created", 3, "CLAUDE-CODE", "Claude Code"),
    ]);
    expect(actors.slices).toHaveLength(1);
    expect(actors.slices[0]).toMatchObject({ key: "agent:claude-code", count: 6, kind: "agent" });
  });

  test("a workspace with no agents is a single people slice, so the caller can skip the circle", () => {
    const actors = groupActorSlices([row("doc.created", 3), row("project.created", 1)]);
    expect(actors.slices).toHaveLength(1);
    expect(actors.slices[0]?.kind).toBe("people");
    expect(actors.agents).toBe(0);
  });

  test("no rows is no slices and no total", () => {
    expect(groupActorSlices([])).toEqual({ total: 0, people: 0, agents: 0, slices: [] });
    // A zero count never becomes an empty slice.
    expect(groupActorSlices([row("doc.created", 0), row("doc.created", 0, "cursor", "Cursor")]).slices).toEqual([]);
  });

  test("the tail folds once there are more agent clients than hues, and names a lone tail client", () => {
    const rows = [
      row("doc.created", 10, "claude-code", "Claude Code"),
      row("doc.created", 8, "cursor", "Cursor"),
      row("doc.created", 5, "codex", "Codex"),
      row("doc.created", 1, "cline", "Cline"),
    ];
    const folded = groupActorSlices(rows, { maxNamedAgents: 2 });
    expect(folded.slices.map((s) => s.key)).toEqual(["agent:claude-code", "agent:cursor", "agents:other"]);
    expect(folded.slices[2]).toMatchObject({ kind: "other", label: "2 other agents", count: 6 });
    expect(folded.total).toBe(24);

    // A tail of exactly one client keeps its name rather than hiding behind "Other agents".
    const lone = groupActorSlices(rows.slice(0, 3), { maxNamedAgents: 2 });
    expect(lone.slices.map((s) => s.label)).toEqual(["Claude Code", "Cursor", "Codex"]);
    expect(lone.slices[2]?.kind).toBe("agent");
  });

  test("ties are ordered by label so the slices never swap between refreshes", () => {
    const a = groupActorSlices([row("doc.created", 2, "cursor", "Cursor"), row("doc.created", 2, "codex", "Codex")]);
    const b = groupActorSlices([row("doc.created", 2, "codex", "Codex"), row("doc.created", 2, "cursor", "Cursor")]);
    expect(a.slices.map((s) => s.label)).toEqual(["Codex", "Cursor"]);
    expect(b.slices.map((s) => s.label)).toEqual(a.slices.map((s) => s.label));
  });

  test("a client with no label falls back to its id rather than an empty legend row", () => {
    const actors = groupActorSlices([row("doc.created", 1, "some-tool", null)]);
    expect(actors.slices[0]?.label).toBe("some-tool");
  });
});

describe("buildActivitySeries", () => {
  const since = new Date("2026-09-01T00:00:00.000Z");

  test("fills every day of the window, oldest first", () => {
    const out = buildActivitySeries([{ day: "2026-09-02", type: "doc.replaced", agent: true, count: 3 }], { since, days: 4 });
    expect(out.map((p) => p.day)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
    expect(out.map((p) => p.total)).toEqual([0, 3, 0, 0]);
  });

  test("splits agents from people and totals them", () => {
    const out = buildActivitySeries(
      [
        { day: "2026-09-01", type: "doc.created", agent: true, count: 2 },
        { day: "2026-09-01", type: "share_link.created", agent: false, count: 5 },
      ],
      { since, days: 1 },
    );
    expect(out[0]).toMatchObject({ day: "2026-09-01", agents: 2, people: 5, total: 7, docsAdded: 2, linksCreated: 5 });
  });

  test("ignores junk rows and negative counts", () => {
    const out = buildActivitySeries(
      [
        { day: "", type: "doc.created", agent: true, count: 9 },
        { day: "2026-09-01", type: "doc.created", agent: false, count: -4 },
      ],
      { since, days: 1 },
    );
    expect(out[0]?.total).toBe(0);
  });
});
