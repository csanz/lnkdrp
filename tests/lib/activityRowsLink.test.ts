/**
 * The name at the head of an activity row, and the row it sits in.
 *
 * Two things are pinned here, for two different reasons.
 *
 * 1. **The subject's link, in priority order.** A recipient (`readerHref`) is not a contributor and
 *    must never be addressed by a contributor key, so it wins outright. After that a row that
 *    carries an agent belongs to the agent, not to the member who connected it - `Doc.replaced`
 *    prints only the member's name ("Christian Sanz replaced X") even when an agent did the work,
 *    so the rule cannot be read off the sentence and has to be read off the row. Reordering these
 *    three is a one-line edit that silently files an agent's work under a person's name, which is
 *    the exact mistake the contributor key exists to prevent.
 *
 * 2. **That the row still renders what it rendered before it moved.** `ActivityRow` and its helpers
 *    were lifted out of `src/app/(app)/activity/pageClient.tsx` whole so that `/activity` and the
 *    contributor pages could share them. The markup below was captured from the page *before* the
 *    move and is byte-for-byte what it produced, minus the `<time>` element (its text and title are
 *    locale- and clock-dependent, and this suite runs wherever it runs). Everything else is the
 *    row's structure: the type icon, the co-authored avatar pair, the three linkable pieces of the
 *    sentence in order, and the controls under it.
 *
 * These suites run in `node` with no DOM, so the row is rendered with `renderToStaticMarkup` the
 * way `markdownCode.test.ts` renders `Markdown`.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, afterAll, describe, expect, test, vi } from "vitest";

import { ActivityRow, subjectHrefFor } from "@/components/activity/ActivityRows";
import type { ActivityItem } from "@/lib/activity/labels";

const PERSON = "/people/6ab46f3a542dc85d9d3ba00f";
const AGENT = "/agents/claude-code/6ab46f3a542dc85d9d3ba00f";
const READER = "/doc/6512c0ffee00000000000003/metrics/viewer/u_1";

describe("subjectHrefFor", () => {
  test("a recipient wins over everything: their page is the reading page, never a contributor page", () => {
    expect(
      subjectHrefFor({ readerHref: READER, agent: { href: AGENT }, actor: { href: PERSON } }),
    ).toBe(READER);
  });

  test("an agent row is the agent's, even when the sentence names its owner", () => {
    expect(subjectHrefFor({ agent: { href: AGENT }, actor: { href: PERSON } })).toBe(AGENT);
  });

  test("a member acting in the app goes to their own page", () => {
    expect(subjectHrefFor({ agent: null, actor: { href: PERSON } })).toBe(PERSON);
  });

  test("a system row belongs to nobody and stays plain text", () => {
    expect(subjectHrefFor({ actor: { href: null } })).toBeNull();
    expect(subjectHrefFor({})).toBeNull();
  });

  test("an empty href is not a link (the API sends null, but \"\" would render href=\"\")", () => {
    expect(subjectHrefFor({ readerHref: "", actor: { href: PERSON } })).toBe(PERSON);
  });
});

/** A row as `/api/activity` sends it, with the `href` fields the route adds for contributors. */
function row(over: Record<string, unknown> = {}): ActivityItem {
  return {
    id: "a2",
    type: "doc.replaced",
    createdDate: "2026-09-25T09:00:00.000Z",
    actor: {
      userId: "6ab46f3a542dc85d9d3ba00f",
      name: "Christian Sanz",
      email: "c@example.com",
      kind: "user",
      href: PERSON,
    },
    agent: { client: "claude-code", label: "Claude Code", version: "1.2", href: AGENT },
    doc: { id: "6512c0ffee00000000000003", title: "Meridian Robotics", shareId: null, deleted: false },
    project: null,
    meta: { version: 3 },
    ...over,
  } as unknown as ActivityItem;
}

/** The row, with the clock-dependent `<time>` collapsed so the pin is stable anywhere. */
function render(item: ActivityItem): string {
  return renderToStaticMarkup(createElement(ActivityRow, { item })).replace(/<time[\s\S]*?<\/time>/, "<time/>");
}

/** Exactly what `/activity` rendered for this row before `ActivityRow` was moved out of it. */
const PIN = [
  "<li class=\"grid \"><div class=\"min-h-0 overflow-hidden\"><div class=\"flex items-start gap-3 px-4 py-3\">",
  "<div class=\"mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--panel-hover)] text-[var(--muted-2)] ring-1 ring-[var(--border)]\">",
  "<svg xmlns=\"http://www.w3.org/2000/svg\" fill=\"none\" viewBox=\"0 0 24 24\" stroke-width=\"1.5\" stroke=\"currentColor\" aria-hidden=\"true\" data-slot=\"icon\" class=\"h-4 w-4\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99\"></path></svg></div>",
  "<div class=\"flex shrink-0 items-center\" aria-hidden=\"true\"><div class=\"relative z-10 rounded-full ring-2 ring-[var(--panel)]\">",
  "<div class=\"grid h-7 w-7 place-items-center rounded-full bg-[var(--panel-hover)] text-[10px] font-semibold text-[var(--muted)] ring-1 ring-[var(--border)]\" title=\"c@example.com\">CS</div></div>",
  "<div class=\"-ml-1.5\">",
  "<div class=\"grid h-7 w-7 place-items-center rounded-full bg-[var(--panel)] text-[var(--muted)] ring-1 ring-[var(--border)]\" title=\"Claude Code 1.2\">",
  "<span role=\"img\" aria-label=\"Claude Code\" class=\"inline-block bg-current h-3.5 w-3.5\" style=\"-webkit-mask-image:url(/agents/claude.svg);mask-image:url(/agents/claude.svg);-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;-webkit-mask-size:contain;mask-size:contain\"></span></div></div></div>",
  "<div class=\"min-w-0 flex-1\"><div class=\"flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] leading-5 text-[var(--muted)]\">",
  "<a title=\"See everything Claude Code changed\" class=\"font-medium text-[var(--fg)] underline decoration-dotted decoration-[var(--muted-2)] underline-offset-4 transition-colors hover:decoration-solid hover:decoration-[var(--fg)]\" href=\"/agents/claude-code/6ab46f3a542dc85d9d3ba00f\">Christian Sanz</a>",
  "<span>replaced</span>",
  "<a class=\"font-semibold text-[var(--fg)] hover:underline underline-offset-4\" href=\"/doc/6512c0ffee00000000000003\">Meridian Robotics</a>",
  "<span> (v3)</span></div><div class=\"mt-0.5 flex items-center gap-2 text-[11px] text-[var(--muted-2)]\"><time/>",
  "<span aria-hidden=\"true\">\u00b7</span>",
  "<button type=\"button\" class=\"hover:text-[var(--fg)] hover:underline underline-offset-4\">What changed</button></div></div></div></div></li>"
].join("");

describe("ActivityRow", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
  });
  afterAll(() => vi.useRealTimers());

  test("renders the row the activity page used to render", () => {
    expect(render(row())).toBe(PIN);
  });

  test("the subject links to the agent, and says so, when an agent did it", () => {
    const html = render(row());
    expect(html).toContain(`href="${AGENT}"`);
    expect(html).not.toContain(`href="${PERSON}"`);
    // The bold name here is the owner's (see `describeActivity`'s `doc.replaced`), so the tooltip
    // has to name the page it opens or the jump reads as a mistake.
    expect(html).toContain('title="See everything Claude Code changed"');
  });

  test("a member's own row links to their page", () => {
    const html = render(row({ agent: null }));
    expect(html).toContain(`href="${PERSON}"`);
    expect(html).toContain('title="See everything they changed"');
  });

  test("a recipient keeps the reading link and its wording, exactly as before", () => {
    const html = render(
      row({
        type: "share.viewed",
        agent: null,
        actor: { userId: null, name: "Dana Reed", email: null, kind: "viewer", href: null },
        readerHref: READER,
        meta: {},
      }),
    );
    expect(html).toContain(`href="${READER}"`);
    expect(html).toContain('title="See what they read"');
  });

  test("a row nobody owns renders the subject as plain text", () => {
    const html = render(
      row({
        type: "doc.processed",
        agent: null,
        actor: { userId: null, name: null, email: null, kind: "system", href: null },
        meta: {},
      }),
    );
    expect(html).toContain('<span class="font-medium text-[var(--fg)]">Processing</span>');
    expect(html).not.toContain("decoration-dotted");
  });
});
