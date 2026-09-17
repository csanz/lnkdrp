import type { PageMeta } from "./types";

const LABEL_MAX = 90;
const ACRONYMS: Record<string, string> = { roi: "ROI", kpi: "KPI", arr: "ARR", mrr: "MRR", gtm: "GTM", tam: "TAM", mwh: "MWh", kwh: "kWh", gwh: "GWh" };
const ACRONYM_RE = new RegExp(`\\b(?:${Object.keys(ACRONYMS).join("|")})\\b`, "gi");

/** Section roles generated slugs start with ("{role}-{heading}"); matched longest first. */
const ROLES = [
  "cover", "problem", "solution", "product", "market", "traction", "business model", "pricing", "competition", "team",
  "financials", "ask", "appendix", "highlights", "metrics", "agenda", "risks", "decisions", "context", "proposal",
  "recommendations", "recommendation", "summary", "approach", "timeline", "terms", "methodology", "findings", "legal",
  "options", "roi", "index", "customers", "roles", "architecture", "data handling", "compliance", "incident response",
  "contact", "roadmap",
]
  .map((r) => r.split(" "))
  .sort((a, b) => b.length - a.length || b.join(" ").length - a.join(" ").length);

/** A heading that starts with one of these continues the role's phrase ("pricing and plans"), so it is not split. */
const CONNECTIVES = new Set(["and", "or", "of", "for", "to", "in", "vs", "&"]);
const FILLER = new Set(["the", "a", "an", "our", "we", "what", "how", "who"]);

function sharesStem(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i >= Math.min(5, n);
}

function tidyWords(text: string): string {
  return text.replace(/\bp l\b/gi, "P&L").replace(ACRONYM_RE, (w) => ACRONYMS[w.toLowerCase()] ?? w.toUpperCase());
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Cut at the last word boundary before LABEL_MAX (a hard cut only for one very long word), then "…". */
function truncate(text: string): string {
  if (text.length <= LABEL_MAX) return text;
  const head = text.slice(0, LABEL_MAX);
  const space = head.lastIndexOf(" ");
  const cut = space > 0 ? head.slice(0, space) : text.slice(0, LABEL_MAX - 1);
  return `${cut.replace(/[\s,;:.–-]+$/, "")}…`;
}

/**
 * Label and short label from a page slug; null for empty or generic slugs ("page-3", "last-page").
 * A recognised "{role}-{heading}" slug reads "Role: Heading" ("Problem: Why clinics are stuck"), or
 * the role alone when the heading only repeats it ("team-the-team" → "Team"); its short label is the
 * role. Other slugs are humanised as they are, with the same short label.
 */
export function pageLabelParts(slug: string | null | undefined): { label: string; shortLabel: string } | null {
  if (typeof slug !== "string") return null;
  const s = slug.trim();
  if (!s || /^page-\d+$/.test(s) || s === "last-page") return null;
  const spaced = s.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) return null;
  // Slugs are often built as "{section}-{heading}", which repeats the section's first word or two.
  const collapsed = spaced.replace(/^(\w+(?: \w+)?) \1\b/i, "$1");
  const words = collapsed.toLowerCase().split(" ");

  const role = ROLES.find((r) => r.every((w, i) => words[i] === w) && !CONNECTIVES.has(words[r.length] ?? ""));
  if (role) {
    const roleText = capitalise(tidyWords(role.join(" ")));
    const rest = words.slice(role.length);
    const content = rest.filter((w) => !FILLER.has(w));
    const redundant = role[0] === "cover" || content.every((w) => role.some((r) => sharesStem(w, r)));
    const label = redundant ? roleText : truncate(`${roleText}: ${capitalise(tidyWords(rest.join(" ")))}`);
    return { label, shortLabel: roleText };
  }

  const tidy = tidyWords(collapsed);
  if (tidy.length < 3) return null;
  const label = truncate(capitalise(tidy));
  return { label, shortLabel: label };
}

/** Human label from a page slug; null for empty or generic slugs. See pageLabelParts. */
export function pageLabel(slug: string | null | undefined): string | null {
  return pageLabelParts(slug)?.label ?? null;
}

export type DocPagesInput = {
  slideNodes?: Array<{ pageNumber?: unknown; thumbUrl?: unknown }> | null;
  pageSlugs?: Array<{ pageNumber?: unknown; slug?: unknown }> | null;
};

/** PageMeta for pages 1..P from a Doc's slideNodes (thumbs) and pageSlugs (labels). */
export function pageMetaFromDoc(doc: DocPagesInput, P: number): PageMeta[] {
  const thumbs = new Map<number, string>();
  for (const n of doc.slideNodes ?? []) {
    if (typeof n?.pageNumber === "number" && typeof n.thumbUrl === "string" && n.thumbUrl) thumbs.set(n.pageNumber, n.thumbUrl);
  }
  const labels = new Map<number, { label: string; shortLabel: string }>();
  for (const s of doc.pageSlugs ?? []) {
    if (typeof s?.pageNumber !== "number" || typeof s.slug !== "string") continue;
    const l = pageLabelParts(s.slug);
    if (l) labels.set(s.pageNumber, l);
  }
  const out: PageMeta[] = [];
  for (let page = 1; page <= P; page++) {
    const l = labels.get(page);
    out.push({ page, label: l?.label ?? null, shortLabel: l?.shortLabel ?? null, thumbUrl: thumbs.get(page) ?? null });
  }
  return out;
}
