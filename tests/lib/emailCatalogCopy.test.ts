/**
 * The Notifications page promises a complete list. This is what keeps that true.
 *
 * The page used to show two dropdowns and nothing else, describing two of the dozen emails the
 * product sends — so the honest fix was to list the rest and say, for each, why it has no switch.
 * A list like that is worth exactly as much as its completeness: one email added to the catalogue
 * without a description here and the page silently goes back to being a fragment that claims to be
 * whole.
 */
import { describe, expect, test } from "vitest";

import { EMAIL_CATALOG } from "@/lib/email/templates";
import { EMAIL_COPY } from "@/lib/email/catalogCopy";

describe("every email we send is described", () => {
  test("no catalogue entry is missing its copy", () => {
    const missing = EMAIL_CATALOG.filter((e) => !EMAIL_COPY[e.id]).map((e) => e.id);
    expect(missing, "add these to EMAIL_COPY or the Notifications page omits them").toEqual([]);
  });

  test("no copy describes an email that no longer exists", () => {
    const known = new Set(EMAIL_CATALOG.map((e) => e.id));
    const orphans = Object.keys(EMAIL_COPY).filter((id) => !known.has(id));
    expect(orphans, "these describe emails that are no longer sent").toEqual([]);
  });

  test("an email with no setting says why not", () => {
    // "You cannot turn this off" is a claim that owes the reader a reason. Leaving `why` empty is
    // how a transactional email quietly becomes one nobody can explain.
    const unexplained = Object.entries(EMAIL_COPY)
      .filter(([, c]) => !c.setting && !(c.why ?? "").trim())
      .map(([id]) => id);
    expect(unexplained).toEqual([]);
  });

  test("an email with a setting does not also argue it cannot be changed", () => {
    const contradictory = Object.entries(EMAIL_COPY)
      .filter(([, c]) => c.setting && (c.why ?? "").trim())
      .map(([id]) => id);
    expect(contradictory).toEqual([]);
  });

  test("every description says what causes the email", () => {
    for (const [id, c] of Object.entries(EMAIL_COPY)) {
      expect(c.label.trim().length, id).toBeGreaterThan(0);
      expect(c.when.trim().length, id).toBeGreaterThan(0);
    }
  });

  test("the settings named are ones the preferences UI actually offers", () => {
    const offered = new Set(["views", "docUpdates", "repoRequests", null]);
    for (const [id, c] of Object.entries(EMAIL_COPY)) {
      expect(offered.has(c.setting), `${id} names a setting that does not exist`).toBe(true);
    }
  });
});
