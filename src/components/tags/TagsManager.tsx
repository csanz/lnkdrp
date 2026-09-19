/**
 * Managing the workspace's tags: rename, recolour, merge, delete.
 *
 * A tag list needs a place like this or it rots. What rots it is never one bad tag — it is
 * "Fundraising" and "fund-raising" and "Fund Raising" arriving over three months from three
 * people, which is why merge is here and is the first thing offered when a rename collides with
 * an existing name.
 *
 * Deleting a tag removes it from everything that carries it. That is said plainly on the button's
 * confirm, with the count, because "delete" on a 40-document tag is not the same action as
 * "delete" on an empty one.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckIcon, TrashIcon } from "@heroicons/react/24/outline";

import TagDot from "@/components/tags/TagDot";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { TAG_COLOR_KEYS, TAG_COLORS, type TagColorKey } from "@/lib/tags/palette";

type Tag = { id: string; name: string; slug: string; color: TagColorKey; count?: number };

export default function TagsManager() {
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState("");
  const [mergeFrom, setMergeFrom] = useState<Tag | null>(null);

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
    const carried = tag.count ?? 0;
    const warning = carried
      ? `Delete “${tag.name}”? It comes off ${carried} ${carried === 1 ? "item" : "items"}. The documents and projects themselves are untouched.`
      : `Delete “${tag.name}”? Nothing carries it.`;
    if (!window.confirm(warning)) return;
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the tag");
    } finally {
      setBusyId("");
    }
  }

  if (tags === null) return <div className="text-[13px] text-[var(--muted-2)]">Loading tags…</div>;

  if (!tags.length) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-[13px] text-[var(--muted)]">
        No tags yet. Add one from any document or project and it shows up here.
      </div>
    );
  }

  return (
    <div>
      {error ? <div className="mb-3 text-[12px] font-medium text-red-600">{error}</div> : null}

      <ul className="grid gap-1.5">
        {sorted.map((tag) => {
          const busy = busyId === tag.id;
          const editing = editingId === tag.id;
          const merging = mergeFrom?.id === tag.id;
          return (
            <li
              key={tag.id}
              className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-3">
                <TagDot color={tag.color} />

                {editing ? (
                  <input
                    autoFocus
                    value={draft}
                    maxLength={60}
                    disabled={busy}
                    aria-label={`Rename ${tag.name}`}
                    className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-[13px] text-[var(--fg)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
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
                    className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[var(--fg)] hover:underline underline-offset-4"
                    title="Rename"
                    onClick={() => {
                      setDraft(tag.name);
                      setEditingId(tag.id);
                    }}
                  >
                    {tag.name}
                  </button>
                )}

                <span className="shrink-0 text-[12px] tabular-nums text-[var(--muted-2)]">
                  {tag.count ?? 0} {(tag.count ?? 0) === 1 ? "item" : "items"}
                </span>

                {/* The palette, inline: six dots is smaller than a picker and needs no explanation. */}
                <span className="flex shrink-0 items-center gap-1">
                  {TAG_COLOR_KEYS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      disabled={busy}
                      aria-label={`${TAG_COLORS[key].label} for ${tag.name}`}
                      title={TAG_COLORS[key].label}
                      onClick={() => {
                        if (key === tag.color) return;
                        void patch(tag, { color: key });
                      }}
                      className={[
                        "grid h-5 w-5 place-items-center rounded-full transition-colors",
                        key === tag.color ? "ring-1 ring-[var(--fg)]" : "hover:bg-[var(--panel-hover)]",
                      ].join(" ")}
                    >
                      <TagDot color={key} size={9} />
                    </button>
                  ))}
                </span>

                <button
                  type="button"
                  disabled={busy || (tags?.length ?? 0) < 2}
                  onClick={() => setMergeFrom(merging ? null : tag)}
                  className="shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 text-[12px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--fg)] disabled:opacity-40"
                  title={(tags?.length ?? 0) < 2 ? "Nothing to merge into yet" : "Merge into another tag"}
                >
                  Merge
                </button>

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(tag)}
                  aria-label={`Delete ${tag.name}`}
                  title="Delete"
                  className="shrink-0 rounded-lg p-1.5 text-[var(--muted-2)] transition-colors hover:bg-[var(--panel-hover)] hover:text-red-600 disabled:opacity-40"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>

              {merging ? (
                <div className="mt-2.5 border-t border-[var(--divider)] pt-2.5">
                  <div className="text-[12px] text-[var(--muted)]">
                    Move everything tagged &ldquo;{tag.name}&rdquo; onto:
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {sorted
                      .filter((t) => t.id !== tag.id)
                      .map((target) => (
                        <button
                          key={target.id}
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            if (
                              !window.confirm(
                                `Merge “${tag.name}” into “${target.name}”? “${tag.name}” is removed and everything it tagged carries “${target.name}” instead.`,
                              )
                            ) {
                              return;
                            }
                            void patch(tag, { mergeIntoTagId: target.id }, () => setMergeFrom(null));
                          }}
                          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1 text-[12px] font-medium text-[var(--fg)] transition-colors hover:bg-[var(--panel-hover)] disabled:opacity-50"
                        >
                          <TagDot color={target.color} />
                          <span className="max-w-[160px] truncate">{target.name}</span>
                          <CheckIcon className="h-3 w-3 text-[var(--muted-2)]" aria-hidden="true" />
                        </button>
                      ))}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-[12px] leading-5 text-[var(--muted-2)]">
        Renaming keeps every document and project that carries the tag. Merging moves them onto the tag you pick and
        removes this one. Deleting takes the tag off everything; the documents and projects themselves are untouched.
      </p>
    </div>
  );
}
