/**
 * Picking tags for one document, project or contact.
 *
 * The inline box this replaces was fine for a workspace with six tags and wrong for one with a
 * hundred: it showed a handful of suggestions under a text field and gave no way to see the rest.
 * A picker shows the whole list, says which ones are already on this item, and lets you toggle
 * several in one sitting — which is how tagging actually happens, in a burst when a document
 * lands, not one tag per visit.
 *
 * Typing filters; Enter attaches the top match, or creates what you typed when nothing matches
 * (find-or-create is one request, so there is no race between checking and creating). Every toggle
 * is written immediately — there is no Save, because a half-applied list nobody confirmed is worse
 * than either state.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, PlusIcon } from "@heroicons/react/24/outline";

import Link from "next/link";

import AgentHintNotice from "@/components/AgentHintNotice";
import Modal from "@/components/modals/Modal";
import TagDot from "@/components/tags/TagDot";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import type { TagTargetKind } from "@/lib/models/TagAssignment";
import type { TagColorKey } from "@/lib/tags/palette";

type Tag = { id: string; name: string; slug: string; color: TagColorKey; count?: number };
export type { TagTargetKind };

/** What the modal calls the thing being tagged. A map, not a ternary: a third kind must not read as the second. */
const TARGET_NOUN: Record<TagTargetKind, string> = { doc: "document", project: "project", contact: "contact" };

const NAME_MAX = 60;

export default function TagPickerModal({
  open,
  onClose,
  targetKind,
  targetId,
  attached,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  targetKind: TagTargetKind;
  targetId: string;
  /** The tags already on this item, so the list can show them ticked from the first paint. */
  attached: Tag[];
  /** Called with the item's tags after every change, so the chips behind the modal keep up. */
  onChanged: (tags: Tag[]) => void;
}) {
  const [all, setAll] = useState<Tag[]>([]);
  const [current, setCurrent] = useState<Tag[]>(attached);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setCurrent(attached);
  }, [attached]);

  const loadAll = useCallback(async () => {
    try {
      const res = await fetchWithTempUser("/api/tags", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { tags?: Tag[] };
      setAll(Array.isArray(json.tags) ? json.tags : []);
    } catch {
      // The list stays as it is; typing a name still works.
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError(null);
    void loadAll();
    // The field, not the first row: the fastest path through this modal is typing.
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open, loadAll]);

  const attachedIds = useMemo(() => new Set(current.map((t) => t.id)), [current]);
  const q = query.trim().toLowerCase();

  /**
   * On this item first — a picker that hides what you already chose makes you check twice — then
   * the rest by use, with names starting with what you typed ahead of names merely containing it.
   */
  const rows = useMemo(() => {
    const pool = q ? all.filter((t) => t.name.toLowerCase().includes(q)) : all;
    return [...pool].sort((a, b) => {
      const aOn = attachedIds.has(a.id) ? 0 : 1;
      const bOn = attachedIds.has(b.id) ? 0 : 1;
      if (aOn !== bOn) return aOn - bOn;
      if (q) {
        const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
      }
      return (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name);
    });
  }, [all, attachedIds, q]);

  const exact = useMemo(() => all.find((t) => t.name.trim().toLowerCase() === q) ?? null, [all, q]);
  const canCreate = Boolean(q) && !exact;

  function applyTags(tags: Tag[]) {
    setCurrent(tags);
    onChanged(tags);
    // The sidebar counts these.
    window.dispatchEvent(new Event("lnkdrp:tags-changed"));
  }

  async function attach(payload: { tagId?: string; name?: string }, key: string) {
    if (busyId) return;
    setBusyId(key);
    setError(null);
    try {
      const res = await fetchWithTempUser("/api/tags/assignments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetKind, targetId, ...payload }),
      });
      const json = (await res.json().catch(() => null)) as { tags?: Tag[]; error?: string } | null;
      if (!res.ok) throw new Error(json?.error || "Could not add the tag");
      applyTags(Array.isArray(json?.tags) ? json!.tags! : []);
      if (payload.name) {
        setQuery("");
        // A tag created here has to join the list, or it disappears the moment the filter clears.
        await loadAll();
      }
      inputRef.current?.focus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the tag");
    } finally {
      setBusyId("");
    }
  }

  async function detach(tagId: string) {
    if (busyId) return;
    setBusyId(tagId);
    setError(null);
    try {
      const res = await fetchWithTempUser("/api/tags/assignments", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetKind, targetId, tagId }),
      });
      const json = (await res.json().catch(() => null)) as { tags?: Tag[]; error?: string } | null;
      if (!res.ok) throw new Error(json?.error || "Could not remove the tag");
      applyTags(Array.isArray(json?.tags) ? json!.tags! : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the tag");
    } finally {
      setBusyId("");
    }
  }

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Add tags" panelClassName="w-[min(520px,calc(100vw-32px))]">
      <div className="text-base font-semibold text-[var(--fg)]">
        Tags for this {TARGET_NOUN[targetKind]}
      </div>
      <div className="mt-1 text-[13px] text-[var(--muted)]">
        Tick the ones that apply, or type a new one. Tags are private to this workspace. Recipients never see them.
      </div>

      <input
        ref={inputRef}
        value={query}
        maxLength={NAME_MAX}
        aria-label="Find or create a tag"
        placeholder="Find a tag, or type a new one"
        className="mt-4 w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[14px] text-[var(--fg)] outline-none placeholder:text-[var(--muted-2)] focus:ring-2 focus:ring-[var(--ring)]"
        onChange={(e) => {
          setQuery(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const name = query.trim();
          if (!name) return;
          // Enter is the fast path: the exact tag if it exists, the top match if one is showing,
          // otherwise the tag this creates.
          const top = rows.find((t) => !attachedIds.has(t.id));
          if (exact) void attach({ tagId: exact.id }, exact.id);
          else if (top && top.name.toLowerCase().startsWith(q)) void attach({ tagId: top.id }, top.id);
          else void attach({ name }, "new");
        }}
      />

      {error ? <div className="mt-2 text-[12px] font-medium text-red-600">{error}</div> : null}

      <div className="mt-3 max-h-[min(50vh,380px)] overflow-auto rounded-xl border border-[var(--border)]">
        {canCreate ? (
          <button
            type="button"
            disabled={Boolean(busyId)}
            onClick={() => void attach({ name: query.trim() }, "new")}
            className="flex w-full items-center gap-2.5 border-b border-[var(--divider)] px-3 py-2.5 text-left text-[13px] text-[var(--fg)] transition-colors hover:bg-[var(--panel-hover)] disabled:opacity-50"
          >
            <PlusIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
            <span className="min-w-0 truncate">
              Create <span className="font-semibold">{query.trim()}</span>
            </span>
          </button>
        ) : null}

        {rows.length ? (
          <ul>
            {rows.map((tag) => {
              const on = attachedIds.has(tag.id);
              return (
                <li key={tag.id}>
                  <button
                    type="button"
                    disabled={Boolean(busyId)}
                    onClick={() => (on ? void detach(tag.id) : void attach({ tagId: tag.id }, tag.id))}
                    aria-pressed={on}
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-[var(--panel-hover)] disabled:opacity-50"
                  >
                    <span
                      className={[
                        "grid h-4 w-4 shrink-0 place-items-center rounded border",
                        on ? "border-transparent bg-[var(--fg)] text-[var(--bg)]" : "border-[var(--border)]",
                      ].join(" ")}
                    >
                      {on ? <CheckIcon className="h-3 w-3" strokeWidth={3} /> : null}
                    </span>
                    <TagDot color={tag.color} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--fg)]">{tag.name}</span>
                    <span className="shrink-0 text-[12px] tabular-nums text-[var(--muted-2)]">{tag.count ?? 0}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : !canCreate ? (
          <div className="px-3 py-6 text-center text-[13px] text-[var(--muted-2)]">
            No tags yet. Type a name to make the first one.
          </div>
        ) : null}
      </div>

      {/* Below the list: the fast path through this modal is typing, and a note must not push the field down. */}
      <AgentHintNotice hintKey="tags" className="mt-3" />

      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-[12px] text-[var(--muted-2)]">
          {current.length} on this {TARGET_NOUN[targetKind]}
          {" · "}
          {/* The moment you are picking tags is the moment you notice one needs renaming. */}
          <Link
            href="/tags"
            className="font-medium text-[var(--muted)] underline underline-offset-2 transition-colors hover:text-[var(--fg)]"
            onClick={onClose}
          >
            Manage tags
          </Link>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] transition-colors hover:bg-[var(--primary-hover-bg)]"
        >
          Done
        </button>
      </div>
    </Modal>
  );
}
