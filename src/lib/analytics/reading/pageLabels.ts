import type { PageMeta } from "./types";

const LABEL_MAX = 48;

/** Human label from a page slug; null for empty or generic slugs ("page-3", "last-page"). */
export function pageLabel(slug: string | null | undefined): string | null {
  if (typeof slug !== "string") return null;
  const s = slug.trim();
  if (!s || /^page-\d+$/.test(s) || s === "last-page") return null;
  const spaced = s.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) return null;
  const cap = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return cap.length > LABEL_MAX ? `${cap.slice(0, LABEL_MAX - 1)}…` : cap;
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
  const labels = new Map<number, string>();
  for (const s of doc.pageSlugs ?? []) {
    if (typeof s?.pageNumber !== "number" || typeof s.slug !== "string") continue;
    const l = pageLabel(s.slug);
    if (l) labels.set(s.pageNumber, l);
  }
  const out: PageMeta[] = [];
  for (let page = 1; page <= P; page++) {
    out.push({ page, label: labels.get(page) ?? null, thumbUrl: thumbs.get(page) ?? null });
  }
  return out;
}
