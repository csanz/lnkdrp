/**
 * URL state for `/search` (`?q=&scope=&sort=&page=`): parsing, defaults and serialisation.
 */

export type Scope = "all" | "documents" | "received" | "projects";
export type Sort = "updated" | "title" | "newest";
export type UrlState = { q: string; scope: Scope; sort: Sort; page: number };

export const SCOPES: { id: Scope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "documents", label: "Documents" },
  { id: "received", label: "Received" },
  { id: "projects", label: "Projects" },
];
export const SORTS: { id: Sort; label: string }[] = [
  { id: "updated", label: "Recently updated" },
  { id: "title", label: "Title A–Z" },
  { id: "newest", label: "Newest" },
];

/** Coerce a raw `scope` param to a known scope (default "all"). */
export function parseScope(v: string | null): Scope {
  return SCOPES.some((s) => s.id === v) ? (v as Scope) : "all";
}
/** Coerce a raw `sort` param to a known sort (default "updated"). */
export function parseSort(v: string | null): Sort {
  return SORTS.some((s) => s.id === v) ? (v as Sort) : "updated";
}
/** Coerce a raw `page` param to a 1-based integer (default 1). */
export function parsePage(v: string | null): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
/** Read the full search state from URL params. */
export function readUrlState(params: URLSearchParams): UrlState {
  return { q: params.get("q") ?? "", scope: parseScope(params.get("scope")), sort: parseSort(params.get("sort")), page: parsePage(params.get("page")) };
}
/** Serialise search state, omitting defaults so the URL stays short (`""` when everything is default). */
export function buildSearch(s: UrlState): string {
  const p = new URLSearchParams();
  if (s.q.trim()) p.set("q", s.q);
  if (s.scope !== "all") p.set("scope", s.scope);
  if (s.sort !== "updated") p.set("sort", s.sort);
  if (s.page > 1) p.set("page", String(s.page));
  const str = p.toString();
  return str ? `?${str}` : "";
}
