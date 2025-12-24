export type StarredDoc = {
  id: string;
  title: string;
  starredAt: number;
};

const STORAGE_KEY = "lnkdrp.starredDocs.v1";
export const STARRED_DOCS_CHANGED_EVENT = "lnkdrp:starred-docs-changed";

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeStarredDocs(value: unknown): StarredDoc[] {
  if (!Array.isArray(value)) return [];
  const out: StarredDoc[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object") continue;
    const o = v as { id?: unknown; title?: unknown; starredAt?: unknown };
    if (typeof o.id !== "string" || !o.id) continue;
    if (typeof o.title !== "string") continue;
    const starredAt = typeof o.starredAt === "number" && Number.isFinite(o.starredAt) ? o.starredAt : 0;
    out.push({ id: o.id, title: o.title, starredAt });
  }
  return out;
}

function readStarredDocsUnsafe(): StarredDoc[] {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  return normalizeStarredDocs(safeParseJson(raw));
}

function writeStarredDocsUnsafe(next: StarredDoc[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(STARRED_DOCS_CHANGED_EVENT));
}

export function getStarredDocs(): StarredDoc[] {
  if (typeof window === "undefined") return [];
  try {
    // Most-recent first
    return readStarredDocsUnsafe().sort((a, b) => (b.starredAt ?? 0) - (a.starredAt ?? 0));
  } catch {
    return [];
  }
}

export function isDocStarred(docId: string): boolean {
  if (!docId) return false;
  return getStarredDocs().some((d) => d.id === docId);
}

export function toggleStarredDoc(doc: { id: string; title: string }): { starred: boolean; docs: StarredDoc[] } {
  if (typeof window === "undefined") return { starred: false, docs: [] };
  try {
    const prev = readStarredDocsUnsafe();
    const exists = prev.some((d) => d.id === doc.id);
    const next = exists
      ? prev.filter((d) => d.id !== doc.id)
      : [{ id: doc.id, title: doc.title || "Document", starredAt: Date.now() }, ...prev];
    writeStarredDocsUnsafe(next);
    return { starred: !exists, docs: next };
  } catch {
    return { starred: false, docs: [] };
  }
}

export function upsertStarredDocTitle(doc: { id: string; title: string }) {
  if (typeof window === "undefined") return;
  try {
    const prev = readStarredDocsUnsafe();
    const idx = prev.findIndex((d) => d.id === doc.id);
    if (idx < 0) return;
    const cur = prev[idx];
    if (cur.title === doc.title) return;
    const next = prev.slice();
    next[idx] = { ...cur, title: doc.title };
    writeStarredDocsUnsafe(next);
  } catch {
    // ignore
  }
}



