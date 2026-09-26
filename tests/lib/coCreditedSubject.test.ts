/**
 * A row credited to a member and their agent names two contributors, so it carries two links.
 *
 * It used to be one link to the agent. On the agent's own page that made "Christian Sanz" a link
 * that went back to the page you were already on, which reads exactly like a broken link, and
 * everywhere else it took you somewhere the name you clicked did not say.
 */
import { describe, expect, it } from "vitest";

import { coCreditedSubject } from "@/components/activity/ActivityRows";
import type { ActivityItem } from "@/lib/activity/labels";

const PERSON = "/people/aaaaaaaaaaaaaaaaaaaaaaaa";
const AGENT = "/agents/claude-code/aaaaaaaaaaaaaaaaaaaaaaaa";

function item(over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "1",
    type: "doc.created",
    createdDate: "2026-09-26T00:00:00.000Z",
    actor: { userId: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "Christian Sanz", email: "c@lnkdrp.com", kind: "user", href: PERSON },
    agent: { client: "claude-code", label: "Claude Code", version: null, href: AGENT },
    doc: null,
    project: null,
    meta: {},
    readerHref: null,
    ...over,
  } as ActivityItem;
}

describe("a row credited to a member and their agent", () => {
  it("splits into two names with a link each", () => {
    const pair = coCreditedSubject(item(), "Christian Sanz and Claude Code");
    expect(pair).toEqual({
      person: "Christian Sanz",
      agentLabel: "Claude Code",
      personHref: PERSON,
      agentHref: AGENT,
    });
  });

  it("splits by name, not by the word and", () => {
    // A document called "Tom and Jerry" must not turn the subject into two contributors.
    expect(coCreditedSubject(item(), "Tom and Jerry")).toBeNull();
  });

  it("leaves a row with only an agent alone", () => {
    const anonymous = { ...item(), actor: { userId: null, name: null, email: null, kind: "user", href: null } } as ActivityItem;
    expect(coCreditedSubject(anonymous, "Claude Code")).toBeNull();
  });

  it("leaves a row with only a member alone", () => {
    expect(coCreditedSubject(item({ agent: null }), "Christian Sanz")).toBeNull();
  });

  it("never splits a recipient's row: a reader is not a contributor", () => {
    const reader = item({ readerHref: "/doc/x/metrics/viewer/u_1" });
    expect(coCreditedSubject(reader, "Christian Sanz and Claude Code")).toBeNull();
  });

  it("still names both when one of them has no page yet", () => {
    const pair = coCreditedSubject(item({ agent: { client: "old", label: "Old Client", version: null, href: null } as ActivityItem["agent"] }), "Christian Sanz and Old Client");
    expect(pair?.person).toBe("Christian Sanz");
    expect(pair?.agentHref).toBeNull();
    // The person still gets their link; only the half that has nowhere to go is plain.
    expect(pair?.personHref).toBe(PERSON);
  });

  it("falls back to the email local part for a member with no name, as the sentence does", () => {
    const noName = item({ actor: { userId: "a", name: null, email: "dana@example.com", kind: "user", href: PERSON } as ActivityItem["actor"] });
    expect(coCreditedSubject(noName, "dana and Claude Code")?.person).toBe("dana");
  });
});
