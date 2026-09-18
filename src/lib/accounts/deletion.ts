/**
 * Account deletion: the rules, kept away from the route and the job that apply them.
 *
 * Deleting is two steps on purpose. Step one is immediate and reversible: the account stops working
 * (sign-in refused, live sessions dropped, keys revoked, links stop resolving) but nothing is
 * destroyed. Step two is the purge, 30 days later, which removes the rows and the stored files for
 * good. The gap is what makes "I deleted the wrong account" survivable, and gives support a window
 * to answer questions about a workspace that has just gone quiet.
 */

/** Days between asking to delete and the purge job being allowed to touch the data. */
export const DELETION_GRACE_DAYS = 30;

/** Why someone is leaving. Optional: nobody has to explain themselves. */
export const DELETION_REASONS = [
  { code: "not_using", label: "I'm not using it" },
  { code: "missing_feature", label: "It's missing something I need" },
  { code: "too_expensive", label: "Too expensive" },
  { code: "switched", label: "I moved to something else" },
  { code: "privacy", label: "Privacy or data concerns" },
  { code: "temporary", label: "Just cleaning up, I may come back" },
  { code: "other", label: "Another reason" },
] as const;

export type DeletionReasonCode = (typeof DELETION_REASONS)[number]["code"];

const CODES = new Set<string>(DELETION_REASONS.map((r) => r.code));

/** The label for a stored code, or the code itself when it predates the list. */
export function reasonLabel(code: string | null | undefined): string | null {
  const c = (code ?? "").trim();
  if (!c) return null;
  return DELETION_REASONS.find((r) => r.code === c)?.label ?? c;
}

/** The typed confirmation the form requires, so deletion cannot be a mis-click. */
export const DELETION_CONFIRM_PHRASE = "delete my account";

export function confirmPhraseMatches(input: string | null | undefined): boolean {
  return (input ?? "").trim().toLowerCase() === DELETION_CONFIRM_PHRASE;
}

export type DeletionRequestInput = { reasonCode?: unknown; reasonText?: unknown; confirm?: unknown };

export type ParsedDeletionRequest = {
  reasonCode: DeletionReasonCode | null;
  reasonText: string | null;
};

/** Longest free-text reason we store. Enough for a paragraph, not an essay. */
export const REASON_TEXT_MAX = 1000;

/**
 * Validate what the form sent. Returns the fields to store, or the message to show.
 * An unknown reason code is dropped rather than rejected: the account still deletes.
 */
export function parseDeletionRequest(
  input: DeletionRequestInput,
): { ok: true; value: ParsedDeletionRequest } | { ok: false; error: string } {
  if (!confirmPhraseMatches(typeof input.confirm === "string" ? input.confirm : "")) {
    return { ok: false, error: `Type "${DELETION_CONFIRM_PHRASE}" to confirm.` };
  }
  const codeRaw = typeof input.reasonCode === "string" ? input.reasonCode.trim() : "";
  const textRaw = typeof input.reasonText === "string" ? input.reasonText.trim() : "";
  if (textRaw.length > REASON_TEXT_MAX) {
    return { ok: false, error: `Keep the reason under ${REASON_TEXT_MAX} characters.` };
  }
  return {
    ok: true,
    value: {
      reasonCode: CODES.has(codeRaw) ? (codeRaw as DeletionReasonCode) : null,
      reasonText: textRaw || null,
    },
  };
}

/** When the purge job may remove this account's data. */
export function purgeAfter(requestedAt: Date, graceDays = DELETION_GRACE_DAYS): Date {
  return new Date(requestedAt.getTime() + graceDays * 24 * 60 * 60 * 1000);
}

/** Whole days left before the purge; 0 once it is due. A past date reads as 0, never "in -3 days". */
export function daysUntilPurge(purgeAt: Date | string | null | undefined, now = new Date()): number | null {
  if (!purgeAt) return null;
  const at = purgeAt instanceof Date ? purgeAt : new Date(purgeAt);
  if (!Number.isFinite(at.getTime())) return null;
  return Math.max(0, Math.ceil((at.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
}
