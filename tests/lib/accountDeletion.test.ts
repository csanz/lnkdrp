import { describe, expect, it } from "vitest";

import {
  DELETION_CONFIRM_PHRASE,
  DELETION_GRACE_DAYS,
  confirmPhraseMatches,
  daysUntilPurge,
  parseDeletionRequest,
  purgeAfter,
  reasonLabel,
} from "@/lib/accounts/deletion";

/**
 * Deleting an account is destructive and one-way after 30 days, so the guard rails are tested:
 * it cannot happen without the typed phrase, and the purge date is what the job reads.
 */
describe("account deletion rules", () => {
  it("refuses without the typed confirmation", () => {
    expect(parseDeletionRequest({ confirm: "" }).ok).toBe(false);
    expect(parseDeletionRequest({ confirm: "yes" }).ok).toBe(false);
    expect(parseDeletionRequest({ confirm: "delete" }).ok).toBe(false);
    const refused = parseDeletionRequest({ confirm: "nope" });
    expect(refused.ok === false && refused.error).toContain(DELETION_CONFIRM_PHRASE);
  });

  it("accepts the phrase regardless of case and spacing", () => {
    expect(confirmPhraseMatches("Delete My Account")).toBe(true);
    expect(confirmPhraseMatches("  delete my account  ")).toBe(true);
    expect(confirmPhraseMatches("delete my acount")).toBe(false);
  });

  it("keeps a known reason and drops an unknown one without blocking the deletion", () => {
    const ok = parseDeletionRequest({ confirm: DELETION_CONFIRM_PHRASE, reasonCode: "too_expensive", reasonText: " too pricey " });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.reasonCode).toBe("too_expensive");
      expect(ok.value.reasonText).toBe("too pricey");
    }
    const unknown = parseDeletionRequest({ confirm: DELETION_CONFIRM_PHRASE, reasonCode: "made_up" });
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect(unknown.value.reasonCode).toBeNull();
  });

  it("refuses a reason longer than the field allows", () => {
    const long = parseDeletionRequest({ confirm: DELETION_CONFIRM_PHRASE, reasonText: "x".repeat(1001) });
    expect(long.ok).toBe(false);
  });

  it("schedules the purge the full grace period out", () => {
    const at = new Date("2026-09-18T10:00:00Z");
    const due = purgeAfter(at);
    expect(due.getTime() - at.getTime()).toBe(DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
  });

  it("counts whole days left, and never counts backwards", () => {
    const now = new Date("2026-09-18T10:00:00Z");
    expect(daysUntilPurge("2026-10-18T10:00:00Z", now)).toBe(30);
    expect(daysUntilPurge("2026-09-18T23:00:00Z", now)).toBe(1);
    expect(daysUntilPurge("2026-09-01T10:00:00Z", now)).toBe(0);
    expect(daysUntilPurge(null, now)).toBeNull();
  });

  it("labels a stored reason, and passes through one it does not know", () => {
    expect(reasonLabel("privacy")).toBe("Privacy or data concerns");
    expect(reasonLabel("legacy_code")).toBe("legacy_code");
    expect(reasonLabel(null)).toBeNull();
  });
});
