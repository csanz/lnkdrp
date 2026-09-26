"use client";

/**
 * The Contacts pages' side of `/api/contacts`.
 *
 * One place for the query shape, so the list, the CSV link and the URL bar all spell a filter
 * the same way: a "Download CSV" that forgot the tag filter, or a reload that lost the sort, is
 * what happens when three places each build their own query string. The types mirror the
 * service's DTOs by import, so a column the API grows is a column the page sees.
 *
 * Reads go through the page cache like Activity and Tags: coming back to Contacts paints the
 * last page at once and refreshes underneath.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { readPageCache, writePageCache } from "@/lib/client/pageCache";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import type { ContactDetail, ContactRow, ContactSort, ContactSourceKind } from "@/lib/contacts/service";

export type { ContactDetail, ContactRow, ContactSort, ContactSourceKind };

/** Rows per page. Fifty is a screen and a half; the API allows up to 200. */
export const CONTACTS_PAGE_SIZE = 50;

/** The sort menu, in the order it is offered. */
export const CONTACT_SORTS: ReadonlyArray<{ id: ContactSort; label: string; defaultDir: "asc" | "desc" }> = [
  { id: "lastSeen", label: "Last seen", defaultDir: "desc" },
  { id: "firstSeen", label: "First seen", defaultDir: "desc" },
  { id: "name", label: "Name", defaultDir: "asc" },
  { id: "domain", label: "Domain", defaultDir: "asc" },
  { id: "documentsRead", label: "Documents read", defaultDir: "desc" },
  { id: "visits", label: "Visits", defaultDir: "desc" },
];

/** How each way of arriving is named on the page. */
export const CONTACT_SOURCE_LABELS: Record<ContactSourceKind, string> = {
  introduced: "Introduced themselves",
  signed_in: "Signed in to read",
  download_request: "Asked to download",
  request_upload: "Uploaded to a request",
};

export const CONTACT_SOURCE_KINDS = Object.keys(CONTACT_SOURCE_LABELS) as ContactSourceKind[];

/** Everything the list can be asked for, as the page holds it. */
export type ContactListQuery = {
  q: string;
  tagId: string;
  source: ContactSourceKind | "";
  domain: string;
  sort: ContactSort;
  dir: "asc" | "desc";
  page: number;
};

export const DEFAULT_CONTACT_QUERY: ContactListQuery = {
  q: "",
  tagId: "",
  source: "",
  domain: "",
  sort: "lastSeen",
  dir: "desc",
  page: 1,
};

/** What `GET /api/contacts` answers. */
export type ContactListPage = {
  items: ContactRow[];
  total: number;
  page: number;
  limit: number;
  identity: boolean;
};

/** `true` for a sort id the API knows. */
export function isContactSort(value: unknown): value is ContactSort {
  return CONTACT_SORTS.some((s) => s.id === value);
}

/** `true` for a source kind the API knows. */
export function isContactSourceKind(value: unknown): value is ContactSourceKind {
  return typeof value === "string" && value in CONTACT_SOURCE_LABELS;
}

/**
 * The query string for `query`, with defaults left out so the URL bar stays short and the
 * cache key for "no filter" is the same whichever way you arrived at it.
 */
export function contactsQueryString(query: ContactListQuery, opts: { paged?: boolean } = {}): string {
  const params = new URLSearchParams();
  if (query.q.trim()) params.set("q", query.q.trim());
  if (query.tagId) params.set("tagId", query.tagId);
  if (query.source) params.set("source", query.source);
  if (query.domain.trim()) params.set("domain", query.domain.trim().toLowerCase());
  if (query.sort !== DEFAULT_CONTACT_QUERY.sort) params.set("sort", query.sort);
  if (query.dir !== DEFAULT_CONTACT_QUERY.dir) params.set("dir", query.dir);
  if (opts.paged !== false) {
    if (query.page > 1) params.set("page", String(query.page));
    params.set("limit", String(CONTACTS_PAGE_SIZE));
  }
  return params.toString();
}

/** The query as the URL bar carries it (no page size; the page number only past the first). */
export function contactsUrlQuery(query: ContactListQuery): string {
  const params = new URLSearchParams(contactsQueryString(query, { paged: false }));
  if (query.page > 1) params.set("page", String(query.page));
  return params.toString();
}

/** Read a query back out of the URL bar; anything unknown falls to the default. */
export function contactsQueryFromSearch(search: string): ContactListQuery {
  const params = new URLSearchParams(search);
  const sort = params.get("sort");
  const dir = params.get("dir");
  const source = params.get("source");
  const page = Number(params.get("page"));
  return {
    q: params.get("q") ?? "",
    tagId: params.get("tagId") ?? "",
    source: isContactSourceKind(source) ? source : "",
    domain: params.get("domain") ?? "",
    sort: isContactSort(sort) ? sort : DEFAULT_CONTACT_QUERY.sort,
    dir: dir === "asc" || dir === "desc" ? dir : DEFAULT_CONTACT_QUERY.dir,
    page: Number.isFinite(page) && page > 1 ? Math.trunc(page) : 1,
  };
}

/** Where "Download CSV" points for the same slice of the list. */
export function contactsExportHref(query: ContactListQuery): string {
  const qs = contactsQueryString(query, { paged: false });
  return qs ? `/api/contacts/export?${qs}` : "/api/contacts/export";
}

/**
 * One page of contacts for `query`, cached per workspace so the second visit paints at once.
 * A `null` query fetches nothing: the page passes that until it has read the URL bar, so the first
 * request is the one the URL asked for and not a default page thrown away a tick later.
 */
export function useContacts(query: ContactListQuery | null): {
  data: ContactListPage | null;
  loading: boolean;
  pending: boolean;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<ContactListPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const requestSeq = useRef(0);

  const qs = query ? contactsQueryString(query) : null;
  const requestedPage = query?.page ?? 1;

  useEffect(() => {
    if (qs === null) return;
    const seq = ++requestSeq.current;
    const cacheKey = `contacts:${qs}`;
    const cached = readPageCache<ContactListPage>(cacheKey);
    if (cached) {
      setData(cached);
      setLoading(false);
      setPending(true);
    } else {
      setLoading(true);
    }
    setError(null);

    (async () => {
      try {
        const res = await fetchWithTempUser(`/api/contacts?${qs}`, { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as Partial<ContactListPage> & { error?: string };
        if (seq !== requestSeq.current) return;
        if (!res.ok) throw new Error(json?.error || "Could not load contacts.");
        const page: ContactListPage = {
          items: Array.isArray(json.items) ? json.items : [],
          total: typeof json.total === "number" ? json.total : 0,
          page: typeof json.page === "number" ? json.page : requestedPage,
          limit: typeof json.limit === "number" ? json.limit : CONTACTS_PAGE_SIZE,
          identity: json.identity === true,
        };
        setData(page);
        writePageCache(cacheKey, page);
      } catch (e) {
        if (seq !== requestSeq.current) return;
        setError(e instanceof Error ? e.message : "Could not load contacts.");
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setPending(false);
        }
      }
    })();
  }, [qs, requestedPage, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { data, loading, pending, error, reload };
}

/** One contact in full, or `null` when the workspace has no such contact. */
export async function fetchContact(contactId: string): Promise<{ contact: ContactDetail; identity: boolean } | null> {
  const res = await fetchWithTempUser(`/api/contacts/${encodeURIComponent(contactId)}`, { cache: "no-store" });
  if (res.status === 404) return null;
  const json = (await res.json().catch(() => ({}))) as { contact?: ContactDetail; identity?: boolean; error?: string };
  if (!res.ok || !json.contact) throw new Error(json?.error || "Could not load the contact.");
  return { contact: json.contact, identity: json.identity === true };
}

/** Replace the note on one contact; an empty string clears it. */
export async function saveContactNote(contactId: string, note: string): Promise<ContactDetail> {
  const res = await fetchWithTempUser(`/api/contacts/${encodeURIComponent(contactId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note }),
  });
  const json = (await res.json().catch(() => ({}))) as { contact?: ContactDetail; error?: string; message?: string };
  if (!res.ok || !json.contact) throw new Error(json?.message || json?.error || "Could not save the note.");
  return json.contact;
}
