"use client";

/**
 * Client UI for `/search`.
 *
 * URL-backed workspace search across documents and projects (`?q=&scope=&sort=&page=`).
 * The URL is the source of truth: typing writes `q` (debounced, `history.replaceState`), filters
 * and paging push entries, and back/forward simply re-read `useSearchParams`. History writes go
 * through `window.history` (which Next syncs into `useSearchParams`) so the route segment is not
 * refetched — and `loading.tsx` never flashes — on every keystroke.
 */

import AppPageHeader, { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { rememberEntityTitles } from "@/lib/client/entityTitles";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { DocResultRow, ProjectResultRow, SearchSkeleton, type SearchDoc, type SearchProject } from "./SearchResultRow";
import { useSkeletonDelay } from "@/lib/client/useSkeletonDelay";
import { SCOPES, SORTS, buildSearch, parseSort, readUrlState, type UrlState } from "./searchUrl";

const PAGE_SIZE = 20;
const PROJECTS_LIMIT = 50;
const DEBOUNCE_MS = 250;
/** Minimum time a page transition takes, so the leave/enter choreography reads as one motion. */
const PAGE_TRANSITION_MIN_MS = 280;
/** Dispatched by the global ⌘K handler (providers.tsx) when already on `/search`. */
const FOCUS_SEARCH_EVENT = "lnkdrp:focus-search";

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}
function timeOf(iso: string | null): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

const PILL_BASE =
  "h-8 rounded-full px-3 text-[12px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]";
const PILL_ON = "bg-[var(--fg)] text-[var(--bg)]";
const PILL_OFF = "border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]";
const PAGE_BTN =
  "h-9 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 text-[13px] font-medium text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] disabled:cursor-not-allowed disabled:opacity-50";

/** Search page body: header with input + filters, then the (paged) results list. */
export default function SearchPageClient() {
  const searchParams = useSearchParams();
  const url = useMemo(() => readUrlState(new URLSearchParams(searchParams.toString())), [searchParams]);
  const q = url.q.trim();
  const { scope, sort, page } = url;

  const [input, setInput] = useState(url.q);
  const [modHint, setModHint] = useState<string | null>(null);
  const [docs, setDocs] = useState<SearchDoc[]>([]);
  const [docsTotal, setDocsTotal] = useState(0);
  const [projects, setProjects] = useState<SearchProject[]>([]);
  const [loading, setLoading] = useState(true);
  const showSkeleton = useSkeletonDelay(loading);
  const [docsPending, setDocsPending] = useState(false);
  const [projectsPending, setProjectsPending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Changes on every page swap so rows remount and replay their enter animation.
  const [pageKey, setPageKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const pendingQRef = useRef<string | null>(null);
  const leavingRef = useRef(false);
  const firstLoadRef = useRef(true);
  const docsReqRef = useRef(0);
  const projectsReqRef = useRef(0);
  const pending = docsPending || projectsPending;

  /** Merge `next` into the live URL and write it without refetching the route segment. */
  const writeUrl = useCallback((next: Partial<UrlState>, mode: "push" | "replace") => {
    const cur = readUrlState(new URLSearchParams(window.location.search));
    const target = `${window.location.pathname}${buildSearch({ ...cur, ...next })}`;
    if (target === `${window.location.pathname}${window.location.search}`) return;
    if (mode === "push") window.history.pushState(null, "", target);
    else window.history.replaceState(null, "", target);
  }, []);

  // Back/forward (or any external URL change) restores the input; our own debounced writes are skipped.
  useEffect(() => {
    if (pendingQRef.current !== null && pendingQRef.current === url.q) {
      pendingQRef.current = null;
      return;
    }
    setInput(url.q);
  }, [url.q]);

  useEffect(() => {
    const ua = navigator.userAgent ?? "";
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "") || /Mac OS X/.test(ua);
    setModHint(isMac ? "⌘K" : "Ctrl K");
  }, []);

  useEffect(() => {
    const onFocusEvt = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener(FOCUS_SEARCH_EVENT, onFocusEvt);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(FOCUS_SEARCH_EVENT, onFocusEvt);
      document.removeEventListener("keydown", onKey);
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, []);

  // Documents: server-side search, page-based.
  useEffect(() => {
    const id = ++docsReqRef.current;
    const ctrl = new AbortController();
    const wasLeaving = leavingRef.current;
    if (!firstLoadRef.current) setDocsPending(true);
    setError(null);
    const minWait = new Promise<void>((r) => window.setTimeout(r, wasLeaving && !prefersReducedMotion() ? PAGE_TRANSITION_MIN_MS : 0));
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (q) params.set("q", q);
    void (async () => {
      try {
        const [res] = await Promise.all([fetchWithTempUser(`/api/docs?${params}`, { cache: "no-store", signal: ctrl.signal }), minWait]);
        const json = (await res.json().catch(() => ({}))) as { docs?: SearchDoc[]; total?: number; error?: string };
        if (!res.ok) throw new Error(json?.error || "Failed to load documents.");
        if (id !== docsReqRef.current) return;
        const nextDocs = Array.isArray(json.docs) ? json.docs : [];
        setDocs(nextDocs);
        // The row you are about to click already shows the name; the page behind it should open
        // with that name rather than a skeleton it fills in a fetch later.
        rememberEntityTitles("doc", nextDocs);
        setDocsTotal(typeof json.total === "number" ? json.total : 0);
        if (wasLeaving) setPageKey((k) => k + 1);
      } catch (e) {
        if (ctrl.signal.aborted || id !== docsReqRef.current) return;
        setError(e instanceof Error ? e.message : "Failed to load documents.");
      } finally {
        if (id === docsReqRef.current) {
          firstLoadRef.current = false;
          leavingRef.current = false;
          setLoading(false);
          setDocsPending(false);
          setLeaving(false);
        }
      }
    })();
    return () => ctrl.abort();
  }, [q, page]);

  // Projects: only when the scope includes them and there is something to search (or scope is Projects).
  const showProjects = (scope === "all" && Boolean(q)) || scope === "projects";
  useEffect(() => {
    const id = ++projectsReqRef.current;
    if (!showProjects) {
      setProjects([]);
      return;
    }
    const ctrl = new AbortController();
    setProjectsPending(true);
    // `sidebar=1` skips slug backfills (like `lite=1`) but still returns description + docCount.
    const params = new URLSearchParams({ sidebar: "1", limit: String(PROJECTS_LIMIT) });
    if (q) params.set("q", q);
    void (async () => {
      try {
        const res = await fetchWithTempUser(`/api/projects?${params}`, { cache: "no-store", signal: ctrl.signal });
        const json = (await res.json().catch(() => ({}))) as { projects?: SearchProject[]; error?: string };
        if (!res.ok) throw new Error(json?.error || "Failed to load projects.");
        if (id !== projectsReqRef.current) return;
        const nextProjects = Array.isArray(json.projects) ? json.projects : [];
        setProjects(nextProjects);
        rememberEntityTitles("project", nextProjects);
      } catch (e) {
        if (ctrl.signal.aborted || id !== projectsReqRef.current) return;
        setError(e instanceof Error ? e.message : "Failed to load projects.");
      } finally {
        if (id === projectsReqRef.current) setProjectsPending(false);
      }
    })();
    return () => ctrl.abort();
  }, [q, showProjects]);

  const showDocs = scope !== "projects";
  const visibleDocs = useMemo(() => {
    if (!showDocs) return [];
    const list = scope === "received" ? docs.filter((d) => Boolean(d.receivedViaRequestProjectId)) : docs.slice();
    if (sort === "title") list.sort((a, b) => (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }));
    else if (sort === "newest") list.sort((a, b) => timeOf(b.createdDate) - timeOf(a.createdDate));
    else list.sort((a, b) => timeOf(b.updatedDate) - timeOf(a.updatedDate));
    return list;
  }, [docs, scope, sort, showDocs]);
  const visibleProjects = useMemo(() => {
    if (!showProjects) return [];
    const needle = q.toLowerCase();
    const list = projects.filter((p) => !needle || (p.name || "").toLowerCase().includes(needle) || (p.description || "").toLowerCase().includes(needle));
    if (sort === "title") list.sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
    else if (sort === "newest") list.sort((a, b) => timeOf(b.createdDate) - timeOf(a.createdDate));
    else list.sort((a, b) => timeOf(b.updatedDate) - timeOf(a.updatedDate));
    return list;
  }, [projects, q, sort, showProjects]);

  const resultCount = visibleDocs.length + visibleProjects.length;
  const rovingIndex = Math.min(activeIndex, Math.max(0, resultCount - 1));
  const hasNext = page * PAGE_SIZE < docsTotal;
  const noResults = !loading && Boolean(q) && resultCount === 0;

  function onInputChange(v: string) {
    setInput(v);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      pendingQRef.current = v;
      writeUrl({ q: v, page: 1 }, "replace");
    }, DEBOUNCE_MS);
  }
  function clearQuery() {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    setInput("");
    pendingQRef.current = "";
    writeUrl({ q: "", page: 1 }, "replace");
    inputRef.current?.focus();
  }
  function focusResult(i: number): boolean {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-result-index="${i}"]`);
    if (!el) return false;
    setActiveIndex(i);
    el.focus();
    el.scrollIntoView?.({ block: "nearest" });
    return true;
  }
  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusResult(0);
    } else if (e.key === "Enter") {
      const first = listRef.current?.querySelector<HTMLElement>('[data-result-index="0"]');
      if (!first) return;
      e.preventDefault();
      first.click();
    }
  }
  function onListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const cur = (e.target as HTMLElement).closest?.("[data-result-index]");
    if (!cur) return;
    const i = Number(cur.getAttribute("data-result-index"));
    if (!Number.isFinite(i)) return;
    e.preventDefault();
    if (e.key === "ArrowDown") focusResult(i + 1);
    else if (i === 0) inputRef.current?.focus();
    else focusResult(i - 1);
  }
  function onRootKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Escape" || !input) return;
    e.preventDefault();
    clearQuery();
  }

  /** Page transition: dim and lift current rows, glide to the top, then let new rows stagger in. */
  function goToPage(n: number) {
    if (loading || pending || n < 1 || n === page) return;
    leavingRef.current = true;
    setLeaving(true);
    listRef.current?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    writeUrl({ page: n }, "push");
  }

  const summary = (() => {
    if (!q) return null;
    const parts: string[] = [];
    if (showDocs) {
      const n = scope === "received" ? visibleDocs.length : docsTotal;
      parts.push(`${n} ${n === 1 ? "document" : "documents"}`);
    }
    if (showProjects) {
      const n = visibleProjects.length;
      parts.push(`${n} ${n === 1 ? "project" : "projects"}`);
    }
    return `${parts.join(" · ")} for “${q}”`;
  })();

  return (
    <div className="flex h-full flex-col" onKeyDown={onRootKeyDown}>
      <AppPageHeader icon={MagnifyingGlassIcon} title="Search" description="Find documents and projects across this workspace.">
        <div className="relative">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-[var(--muted-2)]" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="searchbox"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            inputMode="search"
            enterKeyHint="go"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search documents and projects…"
            aria-label="Search documents and projects"
            data-lnkdrp-search-input=""
            className="h-12 w-full rounded-2xl border border-[var(--border)] bg-[var(--bg)] pl-11 pr-12 sm:pr-28 text-[15px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          />
          <div className="absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
            {input ? (
              <button
                type="button"
                onClick={clearQuery}
                aria-label="Clear search"
                className="grid h-7 w-7 place-items-center rounded-lg text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                <XMarkIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
            {modHint ? (
              <kbd className="hidden h-6 items-center rounded-md border border-[var(--border)] bg-[var(--panel)] px-1.5 font-sans text-[11px] font-medium text-[var(--muted-2)] sm:inline-flex" aria-hidden="true">
                {modHint}
              </kbd>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Search scope">
            {SCOPES.map((s) => {
              const active = s.id === scope;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => writeUrl({ scope: s.id, page: 1 }, "push")}
                  className={[PILL_BASE, active ? PILL_ON : PILL_OFF].join(" ")}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-2 text-[12px] text-[var(--muted-2)]">
            <span>Sort</span>
            <select
              value={sort}
              onChange={(e) => writeUrl({ sort: parseSort(e.target.value) }, "push")}
              className="h-8 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 text-[12px] text-[var(--fg)]"
            >
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </AppPageHeader>

      <div ref={listRef} onKeyDown={onListKeyDown} className={`relative min-h-0 flex-1 overflow-auto bg-[var(--bg)] ${APP_PAGE_GUTTER} py-6`} aria-busy={pending || loading}>
        {pending ? (
          <div aria-hidden="true" className="pointer-events-none sticky top-0 z-10 -mx-5 -mt-6 mb-4 sm:-mx-8 h-0.5 overflow-hidden bg-transparent">
            <div className="h-full w-1/3 bg-[var(--fg)]/60 motion-safe:animate-[lnkdrpIndeterminate_1.05s_ease-in-out_infinite]" />
          </div>
        ) : null}
        {error ? (
          <div className="mb-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 text-sm text-red-700">{error}</div>
        ) : null}

        {loading ? (
          // Search re-runs on every debounced keystroke, so a skeleton with no delay flashes
          // continuously while somebody types. See `useSkeletonDelay`.
          showSkeleton ? <SearchSkeleton /> : null
        ) : noResults ? (
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-4 py-10 text-center text-sm text-[var(--muted)]">
            Nothing matches “{q}”. Try a shorter word or a different spelling.
          </div>
        ) : (
          <div
            key={pageKey}
            className={[
              "grid gap-6 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
              leaving ? "translate-y-1 opacity-40" : "translate-y-0 opacity-100",
            ].join(" ")}
          >
            {summary ? (
              <div className="-mb-3 text-[12px] text-[var(--muted-2)]" aria-live="polite">
                {summary}
              </div>
            ) : null}

            {showDocs ? (
              <section aria-label={q ? "Documents" : "Recent documents"}>
                <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">{q ? "Documents" : "Recent"}</div>
                {visibleDocs.length ? (
                  <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
                    <ul className="divide-y divide-[var(--border)] [&>li:first-child>a]:rounded-t-2xl [&>li:last-child>a]:rounded-b-2xl">
                      {visibleDocs.map((d, i) => (
                        <DocResultRow key={d.id} doc={d} query={q} index={i} resultIndex={i} tabIndex={i === rovingIndex ? 0 : -1} onFocus={setActiveIndex} />
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-4 py-8 text-center text-sm text-[var(--muted)]">
                    {q ? "No documents on this page match." : scope === "received" ? "No received documents yet." : "No documents yet. Upload one to get started."}
                  </div>
                )}
              </section>
            ) : null}

            {showProjects && visibleProjects.length ? (
              <section aria-label="Projects">
                <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">Projects</div>
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
                  <ul className="divide-y divide-[var(--border)] [&>li:first-child>a]:rounded-t-2xl [&>li:last-child>a]:rounded-b-2xl">
                    {visibleProjects.map((p, i) => {
                      const ri = visibleDocs.length + i;
                      return (
                        <ProjectResultRow key={p.id} project={p} query={q} index={visibleDocs.length + i} resultIndex={ri} tabIndex={ri === rovingIndex ? 0 : -1} onFocus={setActiveIndex} />
                      );
                    })}
                  </ul>
                </div>
              </section>
            ) : showProjects && scope === "projects" ? (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-4 py-8 text-center text-sm text-[var(--muted)]">
                {q ? "No projects match." : "No projects yet."}
              </div>
            ) : null}

            {showDocs && (page > 1 || hasNext) ? (
              <nav aria-label="Search pages" className="flex items-center justify-end gap-2 pt-1">
                <button type="button" disabled={page <= 1 || loading || pending} onClick={() => goToPage(page - 1)} className={PAGE_BTN}>
                  Previous
                </button>
                <span className="min-w-[4.5rem] text-center text-[12px] tabular-nums text-[var(--muted-2)]" aria-live="polite">
                  {pending ? "Loading…" : `Page ${page}`}
                </span>
                <button type="button" disabled={!hasNext || loading || pending} onClick={() => goToPage(page + 1)} className={PAGE_BTN}>
                  Next
                </button>
              </nav>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
