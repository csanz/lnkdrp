/**
 * Funding-ask fallbacks from document text.
 *
 * When the model leaves `ask` empty, the processing job used to take the first dollar amount in the
 * document, so an operating cost ("$65 per flight hour") became the ask on a public share page.
 * These helpers only accept an amount stated next to raise language, and never one that is a unit
 * price ("per hour", "per aircraft", "each").
 */

/** Dollar amounts in order of appearance, de-duplicated: `$2M`, `$12,000`, `$1.5 million`. */
export function extractDollarAmounts(text: string): string[] {
  const rx = /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:[kKmMbB]\b|thousand|million|billion))?/g;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of (text || "").matchAll(rx)) {
    const a = (m[0] ?? "").replace(/\s+/g, " ").replace(/^\$ /, "$").trim();
    const key = a.toUpperCase();
    if (!a || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

const RAISE_WORDS =
  /\b(raise|raising|raised|seeking|seek|looking to raise|fund(?:ing|raise|raising)?|investment|invest|round|pre-seed|seed|series\s+[a-d]|safe|convertible note|bridge|capital)\b/i;
const UNIT_PRICE = /^\s*(?:\/|per\b|each\b|a (?:month|year|hour|unit)\b|an hour\b|monthly\b|annually\b)/i;

/**
 * The first dollar amount stated as a raise: raise language within ~60 characters before or ~40
 * after it in the same sentence, and not followed by a unit ("per hour", "/mo", "each").
 */
export function findRaiseAmount(text: string): string | null {
  const t = text || "";
  const rx = /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:[kKmMbB]\b|thousand|million|billion))?/g;
  for (const m of t.matchAll(rx)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    // Context stays inside the amount's own sentence, so "$40K MRR. We are raising $2M" picks $2M.
    const after = t.slice(end, end + 40).split(/[.!?](?:\s|$)|\n/)[0] ?? "";
    if (UNIT_PRICE.test(after)) continue;
    const beforeRaw = t.slice(Math.max(0, start - 60), start);
    const before = beforeRaw.split(/[.!?]\s|\n/).pop() ?? "";
    if (RAISE_WORDS.test(before) || RAISE_WORDS.test(after)) {
      return m[0].replace(/\s+/g, " ").replace(/^\$ /, "$").trim();
    }
  }
  return null;
}

/** "Raising $2M to hire…" → "hire…" when the text says what the money is for. */
export function extractAskDetailFromText(text: string, amount: string): string | null {
  const escaped = amount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`Raising\\s+${escaped}\\s+to\\s+([^\\n.]+)`, "i"),
    new RegExp(`Raise\\s+${escaped}\\s+to\\s+([^\\n.]+)`, "i"),
    new RegExp(`${escaped}\\s+to\\s+([^\\n.]+)`, "i"),
  ];
  for (const rx of patterns) {
    const m = rx.exec(text || "");
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/**
 * The ask to store: the model's sentence when it wrote one; a bare amount from the model only when
 * the text states it as a raise; otherwise the first raise amount in the text, with its purpose when
 * the text gives one. Empty when the document states no raise.
 */
export function resolveAsk(modelAsk: string, text: string, fallbackPurpose?: string | null): string {
  const ask = (modelAsk ?? "").trim();
  if (ask && ask.length >= 12 && /\s/.test(ask)) return ask;
  const raise = findRaiseAmount(text);
  const bareAmountConfirmed = ask && raise && raise.replace(/[\s,]/g, "").toUpperCase().startsWith(ask.replace(/[\s,]/g, "").toUpperCase());
  const amount = bareAmountConfirmed ? ask : raise;
  if (!amount) return "";
  const detail = extractAskDetailFromText(text, amount) || (fallbackPurpose ?? "").trim();
  return detail ? `${amount} to ${detail.replace(/^to\s+/i, "").trim().replace(/\.$/, "")}.` : amount;
}
