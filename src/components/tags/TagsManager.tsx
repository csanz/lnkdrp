/**
 * Managing the workspace's tags: rename, recolour, merge, delete.
 *
 * A tag list needs a place like this or it rots. What rots it is never one bad tag — it is
 * "Fundraising" and "fund-raising" and "Fund Raising" arriving over three months from three
 * people, which is why merge is here and is the first thing offered when a rename collides with
 * an existing name.
 *
 * Deleting a tag removes it from everything that carries it. The confirmation is a row that opens
 * in place, naming the count, rather than a browser dialog: a native `confirm()` is a grey box
 * from another era of the web that says nothing about what is about to happen, and on a
 * 40-document tag that difference matters.
 */
"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { CheckIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";

import TagDot from "@/components/tags/TagDot";
import DataTable from "@/components/ui/DataTable";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { TAG_COLOR_KEYS, TAG_COLORS, type TagColorKey } from "@/lib/tags/palette";

type Tag = { id: string; name: string; slug: string; color: TagColorKey; count?: number };

/**
 * Tags per page. A workspace that files properly ends up with dozens, and the page was rendering
 * every one of them into a single scroll.
 */
const PAGE_SIZE = 24;

export default function TagsManager() {
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState("");
  const [mergeFrom, setMergeFrom] = useState<Tag | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Tag | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  /** Which row has its palette open; only one at a time, so the table does not grow six rows at once. */
  const [colorFor, setColorFor] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetchWithTempUser("/api/tags", { cache: "no-store" });
      if (!res.ok) {
        setTags([]);
        return;
      }
      const json = (await res.json()) as { tags?: Tag[] };
      setTags(Array.isArray(json.tags) ? json.tags : []);
    } catch {
      setTags([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(
    () => [...(tags ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name)),
    [tags],
  );

  /**
   * Filter before paging, so searching looks through every tag rather than the page you are on.
   * Folded loosely on purpose — someone hunting "Série A" should find it by typing "serie".
   */
  const matching = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return sorted;
    const fold = (v: string) => v.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const folded = fold(needle);
    return sorted.filter((t) => fold(t.name).includes(folded) || t.slug.includes(folded));
  }, [sorted, filter]);

  const pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  // A filter that shortens the list can strand you past the end; clamp rather than show nothing.
  const current = Math.min(page, pageCount);
  const visible = useMemo(
    () => matching.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE),
    [matching, current],
  );

  /** Every write goes through here: one busy row at a time, one error line, one refresh. */
  async function patch(tag: Tag, body: Record<string, unknown>, onDone?: () => void) {
    if (busyId) return;
    setBusyId(tag.id);
    setError(null);
    try {
      const res = await fetchWithTempUser(`/api/tags/${encodeURIComponent(tag.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error || "Could not update the tag");
      await load();
      window.dispatchEvent(new Event("lnkdrp:tags-changed"));
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the tag");
    } finally {
      setBusyId("");
    }
  }

  async function remove(tag: Tag) {
    if (busyId) return;
    setBusyId(tag.id);
    setError(null);
    try {
      const res = await fetchWithTempUser(`/api/tags/${encodeURIComponent(tag.id)}`, { method: "DELETE" });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error || "Could not delete the tag");
      }
      await load();
      window.dispatchEvent(new Event("lnkdrp:tags-changed"));
      setConfirmDelete(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the tag");
    } finally {
      setBusyId("");
    }
  }

  /** Make a tag that nothing carries yet — the one thing the picker cannot do from here. */
  async function create() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetchWithTempUser("/api/tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error || "Could not create the tag");
      setNewName("");
      await load();
      window.dispatchEvent(new Event("lnkdrp:tags-changed"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the tag");
    } finally {
      setCreating(false);
    }
  }

  if (tags === null) return <div className="text-[13px] text-[var(--muted-2)]">Loading tags…</div>;

  return (
    <div>
      {error ? <div className="mb-3 text-[12px] font-medium text-red-600">{error}</div> : null}

      {/* Tags are normally made by typing one onto a document; this is for the times you are
          setting up a scheme before there is anything to put in it. */}
      <div className="mb-3 flex items-center gap-2">
        <input
          value={newName}
          maxLength={60}
          disabled={creating}
          placeholder="New tag"
          aria-label="New tag name"
          className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] outline-none placeholder:text-[var(--muted-2)] focus:ring-2 focus:ring-[var(--ring)]"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void create();
            }
          }}
        />
        <button
          type="button"
          disabled={creating || !newName.trim()}
          onClick={() => void create()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary-bg)] px-3 py-2 text-[13px] font-semibold text-[var(--primary-fg)] transition-colors hover:bg-[var(--primary-hover-bg)] disabled:opacity-50"
        >
          <PlusIcon className="h-4 w-4" aria-hidden="true" />
          Add
        </button>
      </div>

      {sorted.length > 8 ? (
        <div className="mb-3 flex items-center gap-2">
          <input
            value={filter}
            placeholder={`Search ${sorted.length} tags`}
            aria-label="Search tags"
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] outline-none placeholder:text-[var(--muted-2)] focus:ring-2 focus:ring-[var(--ring)]"
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(1);
            }}
          />
          {filter ? (
            <button
              type="button"
              onClick={() => {
                setFilter("");
                setPage(1);
              }}
              className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-2 text-[13px] text-[var(--muted)] hover:text-[var(--fg)]"
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      {!sorted.length ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-[13px] text-[var(--muted)]">
          No tags yet. Type one above, or add one from any document or project.
        </div>
      ) : null}

      {sorted.length && !matching.length ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-[13px] text-[var(--muted)]">
          No tag matches &ldquo;{filter}&rdquo;.
        </div>
      ) : null}

      {/* Two columns once there is room: a tag row needs about half a wide screen, and one column
          on a 2,000px page was mostly empty space beside a list that still had to be scrolled. */}
      {/* A table, not cards: every tag is the same four facts — colour, name, how many things carry
          it, what you can do to it — and a table is what aligns four identical facts. The card
          layout put the count wherever the name happened to end, so no two rows lined up, and six
          always-visible swatches per row made a list of twenty read as a hundred coloured dots.
          Colour is one dot now and opens the palette when you click it. */}
      <DataTable containerClassName="bg-[var(--panel-2)]">
        <thead className="bg-[var(--panel)] text-[12px] font-semibold text-[var(--muted-2)]">
          <tr>
            <th className="w-10 px-3 py-2.5" aria-label="Colour" />
            <th className="px-3 py-2.5">Tag</th>
            <th className="w-24 px-3 py-2.5 text-right">Items</th>
            <th className="w-44 px-3 py-2.5 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((tag) => {
            const busy = busyId === tag.id;
            const editing = editingId === tag.id;
            const merging = mergeFrom?.id === tag.id;
            const picking = colorFor === tag.id;
            const open = merging || confirmDelete?.id === tag.id;
            return (
              <Fragment key={tag.id}>
                <tr className={`border-t border-[var(--divider)] ${open ? "" : "hover:bg-[var(--panel-hover)]"}`}>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Change colour of ${tag.name}`}
                      title="Change colour"
                      onClick={() => setColorFor(picking ? "" : tag.id)}
                      className="grid h-6 w-6 place-items-center rounded-full transition-colors hover:bg-[var(--panel-hover)] disabled:opacity-40"
                    >
                      <TagDot color={tag.color} />
                    </button>
                  </td>

                  <td className="px-3 py-2">
                    {editing ? (
                      <input
                        autoFocus
                        value={draft}
                        maxLength={60}
                        disabled={busy}
                        aria-label={`Rename ${tag.name}`}
                        className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-[13px] text-[var(--fg)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            const name = draft.trim();
                            if (!name || name === tag.name) {
                              setEditingId("");
                              return;
                            }
                            void patch(tag, { name }, () => setEditingId(""));
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditingId("");
                          }
                        }}
                        onBlur={() => setEditingId("")}
                      />
                    ) : (
                      <button
                        type="button"
                        className="max-w-full truncate text-left text-[13px] font-medium text-[var(--fg)] underline-offset-4 hover:underline"
                        title="Rename"
                        onClick={() => {
                          setDraft(tag.name);
                          setEditingId(tag.id);
                        }}
                      >
                        {tag.name}
                      </button>
                    )}
                  </td>

                  <td className="px-3 py-2 text-right text-[12px] tabular-nums text-[var(--muted-2)]">
                    {tag.count ?? 0}
                  </td>

                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        disabled={busy || (tags?.length ?? 0) < 2}
                        onClick={() => setMergeFrom(merging ? null : tag)}
                        className="rounded-lg border border-[var(--border)] px-2 py-1 text-[12px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--fg)] disabled:opacity-40"
                        title={(tags?.length ?? 0) < 2 ? "Nothing to merge into yet" : "Merge into another tag"}
                      >
                        Merge
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setMergeFrom(null);
                          setConfirmDelete(confirmDelete?.id === tag.id ? null : tag);
                        }}
                        aria-label={`Delete ${tag.name}`}
                        title="Delete"
                        className="rounded-lg p-1.5 text-[var(--muted-2)] transition-colors hover:bg-[var(--panel-hover)] hover:text-red-600 disabled:opacity-40"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>

                {/* The palette, opened from the dot rather than shown on every row at all times. */}
                {picking ? (
                  <tr className="bg-[var(--panel)]">
                    <td colSpan={4} className="px-3 pb-2.5 pt-0">
                      <div className="flex items-center gap-1.5">
                        {TAG_COLOR_KEYS.map((key) => (
                          <button
                            key={key}
                            type="button"
                            disabled={busy}
                            aria-label={`${TAG_COLORS[key].label} for ${tag.name}`}
                            title={TAG_COLORS[key].label}
                            onClick={() => {
                              setColorFor("");
                              if (key === tag.color) return;
                              void patch(tag, { color: key });
                            }}
                            className={[
                              "grid h-6 w-6 place-items-center rounded-full transition-colors",
                              key === tag.color ? "ring-1 ring-[var(--fg)]" : "hover:bg-[var(--panel-hover)]",
                            ].join(" ")}
                          >
                            <TagDot color={key} size={10} />
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ) : null}

                {confirmDelete?.id === tag.id ? (
                  <tr className="bg-[var(--panel)]">
                    <td colSpan={4} className="px-3 pb-3 pt-0">
                      <div className="text-[13px] text-[var(--fg)]">
                        Delete &ldquo;{tag.name}&rdquo;?{" "}
                        <span className="text-[var(--muted)]">
                          {(tag.count ?? 0) > 0
                            ? `It comes off ${tag.count} ${tag.count === 1 ? "item" : "items"}. The documents and projects themselves are untouched.`
                            : "Nothing carries it."}
                        </span>
                      </div>
                      <div className="mt-2.5 flex items-center gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void remove(tag)}
                          className="inline-flex items-center rounded-lg bg-red-600 px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                        >
                          {busy ? "Deleting…" : "Delete"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirmDelete(null)}
                          className="inline-flex items-center rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12px] font-semibold text-[var(--fg)] transition-colors hover:bg-[var(--panel-hover)] disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : null}

                {merging ? (
                  <tr className="bg-[var(--panel)]">
                    <td colSpan={4} className="px-3 pb-3 pt-0">
                      <div className="text-[13px] text-[var(--fg)]">
                        Move everything tagged &ldquo;{tag.name}&rdquo; onto:{" "}
                        <span className="text-[var(--muted)]">
                          &ldquo;{tag.name}&rdquo; is removed; nothing it tagged is.
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {sorted
                          .filter((t) => t.id !== tag.id)
                          .map((target) => (
                            <button
                              key={target.id}
                              type="button"
                              disabled={busy}
                              onClick={() => void patch(tag, { mergeIntoTagId: target.id }, () => setMergeFrom(null))}
                              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1 text-[12px] font-medium text-[var(--fg)] transition-colors hover:bg-[var(--panel-hover)] disabled:opacity-50"
                            >
                              <TagDot color={target.color} />
                              <span className="max-w-[160px] truncate">{target.name}</span>
                              <CheckIcon className="h-3 w-3 text-[var(--muted-2)]" aria-hidden="true" />
                            </button>
                          ))}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </DataTable>

      {pageCount > 1 ? (
        <div className="mt-4 flex items-center justify-between gap-3 text-[13px]">
          <span className="text-[var(--muted)]">
            {(current - 1) * PAGE_SIZE + 1}–{Math.min(current * PAGE_SIZE, matching.length)} of {matching.length}
            {filter ? ` matching` : ""}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={current <= 1}
              onClick={() => setPage(current - 1)}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 font-medium text-[var(--fg)] disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-[var(--muted)]">
              {current} / {pageCount}
            </span>
            <button
              type="button"
              disabled={current >= pageCount}
              onClick={() => setPage(current + 1)}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 font-medium text-[var(--fg)] disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}

      <p className="mt-3 text-[12px] leading-5 text-[var(--muted-2)]">
        Renaming keeps every document and project that carries the tag. Merging moves them onto the tag you pick and
        removes this one. Deleting takes the tag off everything; the documents and projects themselves are untouched.
      </p>
    </div>
  );
}
