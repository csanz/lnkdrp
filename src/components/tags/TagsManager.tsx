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
import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";

import TagDot from "@/components/tags/TagDot";
import Modal from "@/components/modals/Modal";
import DataTable from "@/components/ui/DataTable";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { TAG_COLOR_KEYS, TAG_COLORS, type TagColorKey } from "@/lib/tags/palette";

type Tag = { id: string; name: string; slug: string; color: TagColorKey; count?: number };

/**
 * Tags per page. A workspace that files properly ends up with dozens, and the page was rendering
 * every one of them into a single scroll.
 */
const PAGE_SIZE = 24;

/** How many merge targets the dialog lists before asking you to search instead. */
const MERGE_LIST_CAP = 50;

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
  const [adding, setAdding] = useState(false);
  const [mergeQuery, setMergeQuery] = useState("");

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

  /**
   * Who this tag can be merged into: every other tag, searched and capped. The cap is what makes
   * this survive a workspace with thousands — the dialog renders a list you can read, not one you
   * scroll for a minute.
   */
  const mergeAll = useMemo(() => {
    if (!mergeFrom) return [];
    const needle = mergeQuery.trim().toLowerCase();
    const fold = (v: string) => v.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const folded = fold(needle);
    return sorted.filter(
      (t) => t.id !== mergeFrom.id && (!folded || fold(t.name).includes(folded) || t.slug.includes(folded)),
    );
  }, [sorted, mergeFrom, mergeQuery]);
  const mergeCandidates = mergeAll.slice(0, MERGE_LIST_CAP);
  const mergeTruncated = mergeAll.length > MERGE_LIST_CAP;

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
      // Only on success: a name the server refused (a duplicate, most likely) stays in the dialog
      // with the error beside it, rather than closing and leaving the person to work out what
      // happened from a list that did not change.
      setAdding(false);
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

      {/* One bar: search takes the width because it is used constantly, and creating a tag is a
          button because it is not. Two full-width fields stacked on top of each other read as one
          control that had been duplicated, and put the rare action above the common one.

          Tags are normally made by typing one onto a document; this page is for setting up a
          scheme before there is anything to put in it, which is exactly the case that does not
          deserve a permanently empty text field. */}
      <div className="mb-3 flex items-center gap-2">
        <input
          value={filter}
          placeholder={sorted.length > 8 ? `Search ${sorted.length} tags` : "Search tags"}
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
        <button
          type="button"
          onClick={() => {
            setNewName(filter.trim());
            setAdding(true);
          }}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary-bg)] px-3 py-2 text-[13px] font-semibold text-[var(--primary-fg)] transition-colors hover:bg-[var(--primary-hover-bg)]"
        >
          <PlusIcon className="h-4 w-4" aria-hidden="true" />
          New tag
        </button>
      </div>

      {/* Merging asks "onto which tag?", and the honest answer at any real size is a search box.
          This used to render every other tag as a chip under the row: fine at six, unusable at
          three hundred, and it pushed the table off the screen to ask one question. Searchable,
          scrollable, and capped — a list you scroll past a hundred of is not a list you are
          reading. */}
      <Modal
        open={Boolean(mergeFrom)}
        onClose={() => {
          if (!busyId) setMergeFrom(null);
        }}
        ariaLabel="Merge tag"
        width={460}
        contentClassName="px-6 pb-6 pt-5"
      >
        {mergeFrom ? (
          <>
            <div className="flex items-center gap-2 text-base font-semibold text-[var(--fg)]">
              <TagDot color={mergeFrom.color} />
              <span className="truncate">Merge &ldquo;{mergeFrom.name}&rdquo; into…</span>
            </div>
            <p className="mt-1.5 text-[13px] leading-5 text-[var(--muted)]">
              Everything tagged &ldquo;{mergeFrom.name}&rdquo;
              {(mergeFrom.count ?? 0) > 0 ? ` (${mergeFrom.count} ${mergeFrom.count === 1 ? "item" : "items"})` : ""} moves
              onto the tag you pick. &ldquo;{mergeFrom.name}&rdquo; is then removed; nothing it tagged is.
            </p>

            <input
              autoFocus
              value={mergeQuery}
              placeholder="Search tags"
              aria-label="Search tags to merge into"
              className="mt-4 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] outline-none placeholder:text-[var(--muted-2)] focus:ring-2 focus:ring-[var(--ring)]"
              onChange={(e) => setMergeQuery(e.target.value)}
            />

            <ul className="mt-3 max-h-[320px] overflow-auto rounded-lg border border-[var(--border)]">
              {mergeCandidates.length ? (
                mergeCandidates.map((target) => (
                  <li key={target.id} className="border-b border-[var(--divider)] last:border-b-0">
                    <button
                      type="button"
                      disabled={Boolean(busyId)}
                      onClick={() => void patch(mergeFrom, { mergeIntoTagId: target.id }, () => setMergeFrom(null))}
                      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-[var(--panel-hover)] disabled:opacity-50"
                    >
                      <TagDot color={target.color} />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--fg)]">{target.name}</span>
                      <span className="shrink-0 text-[12px] tabular-nums text-[var(--muted-2)]">{target.count ?? 0}</span>
                    </button>
                  </li>
                ))
              ) : (
                <li className="px-3 py-6 text-center text-[13px] text-[var(--muted)]">
                  {mergeQuery.trim() ? `No tag matches “${mergeQuery}”.` : "No other tag to merge into."}
                </li>
              )}
            </ul>

            {mergeTruncated ? (
              <div className="mt-2 text-[12px] text-[var(--muted-2)]">
                Showing the first {MERGE_LIST_CAP}. Search to narrow it.
              </div>
            ) : null}

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                disabled={Boolean(busyId)}
                onClick={() => setMergeFrom(null)}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-[13px] font-semibold text-[var(--fg)] transition-colors hover:bg-[var(--panel-hover)] disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </>
        ) : null}
      </Modal>

      {/* A dialog for one field, because the alternative was that field sitting empty on the page
          forever. Opens carrying whatever is in the search box: searching for a tag and not finding
          it is the most likely reason anyone presses this. */}
      <Modal
        open={adding}
        onClose={() => {
          if (!creating) setAdding(false);
        }}
        ariaLabel="New tag"
        width={420}
        contentClassName="px-6 pb-6 pt-5"
      >
        <div className="text-base font-semibold text-[var(--fg)]">New tag</div>
        <p className="mt-1.5 text-[13px] leading-5 text-[var(--muted)]">
          Tags are private to this workspace — recipients never see them. A colour is picked for you
          and you can change it afterwards.
        </p>
        <input
          autoFocus
          value={newName}
          maxLength={60}
          disabled={creating}
          placeholder="Fundraising"
          aria-label="New tag name"
          className="mt-4 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] outline-none placeholder:text-[var(--muted-2)] focus:ring-2 focus:ring-[var(--ring)]"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void create();
            }
          }}
        />
        {error && adding ? <div className="mt-3 text-[12px] font-medium text-red-600">{error}</div> : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={creating}
            onClick={() => setAdding(false)}
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-[13px] font-semibold text-[var(--fg)] transition-colors hover:bg-[var(--panel-hover)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={creating || !newName.trim()}
            onClick={() => void create()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-bg)] px-3 py-2 text-[13px] font-semibold text-[var(--primary-fg)] transition-colors hover:bg-[var(--primary-hover-bg)] disabled:opacity-50"
          >
            {creating ? "Adding…" : "Add tag"}
          </button>
        </div>
      </Modal>

      {!sorted.length ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-[13px] text-[var(--muted)]">
          No tags yet. Use New tag above, or add one from any document or project.
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
            <th className="w-16 px-3 py-2.5">Colour</th>
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
                <tr className={`group border-t border-[var(--divider)] ${open ? "" : "hover:bg-[var(--panel-hover)]"}`}>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Change colour of ${tag.name}`}
                      title="Change colour"
                      onClick={() => setColorFor(picking ? "" : tag.id)}
                      className="grid h-7 w-7 place-items-center rounded-full ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--panel-hover)] hover:ring-[var(--fg)] disabled:opacity-40"
                    >
                      <TagDot color={tag.color} size={11} />
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
                    {/* Twenty-four rows meant twenty-four Merge buttons and twenty-four bins
                        competing with the names. They are one keystroke or one hover away instead,
                        and stay put once a row is open so a panel never loses its own controls. */}
                    <div
                      className={`flex items-center justify-end gap-1.5 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
                        open ? "opacity-100" : "opacity-0"
                      }`}
                    >
                      <button
                        type="button"
                        disabled={busy || (tags?.length ?? 0) < 2}
                        onClick={() => {
                          setMergeQuery("");
                          setMergeFrom(merging ? null : tag);
                        }}
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
