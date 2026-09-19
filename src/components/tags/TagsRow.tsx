/**
 * The tags on one document or project: the chips, and the box that adds another.
 *
 * Type a name and press Enter. That is one call, not two — `POST /api/tags/assignments` takes a
 * *name*, finds or creates the tag and attaches it in the same request — so there is no window in
 * which two people typing "Fundraising" at once produce two tags. Suggestions come from the
 * workspace's existing tags and are filtered as you type, because the failure mode for tagging is
 * not a typo, it is five near-identical tags nobody consolidates.
 *
 * Reading is open to any member; writing takes the same role the server enforces, and `canManage`
 * fails closed while the plan snapshot loads, so nobody is shown an input the API will refuse.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";

import TagDot from "@/components/tags/TagDot";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import type { TagColorKey } from "@/lib/tags/palette";

type Tag = { id: string; name: string; slug: string; color: TagColorKey; count?: number };
export type TagTargetKind = "doc" | "project";

/** Tag names are short; this is the same bound the server applies. */
const NAME_MAX = 60;

export default function TagsRow({
  targetKind,
  targetId,
  canManage = true,
  className,
}: {
  targetKind: TagTargetKind;
  targetId: string;
  canManage?: boolean;
  className?: string;
}) {
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [all, setAll] = useState<Tag[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ targetKind, targetId });
      const res = await fetchWithTempUser(`/api/tags/assignments?${qs.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        setTags([]);
        return;
      }
      const json = (await res.json()) as { tags?: Tag[] };
      setTags(Array.isArray(json.tags) ? json.tags : []);
    } catch {
      setTags([]);
    }
  }, [targetKind, targetId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The workspace's tags, for suggestions. Only once the input opens: a document page should not
  // pay for a list nobody is about to read.
  useEffect(() => {
    if (!adding || all.length) return;
    void (async () => {
      try {
        const res = await fetchWithTempUser("/api/tags", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { tags?: Tag[] };
        setAll(Array.isArray(json.tags) ? json.tags : []);
      } catch {
        // Suggestions are a convenience; typing a name still works without them.
      }
    })();
  }, [adding, all.length]);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const attached = useMemo(() => new Set((tags ?? []).map((t) => t.id)), [tags]);
  const query = draft.trim().toLowerCase();
  const suggestions = useMemo(() => {
    if (!adding) return [];
    return all
      .filter((t) => !attached.has(t.id))
      .filter((t) => (query ? t.name.toLowerCase().includes(query) : true))
      .slice(0, 6);
  }, [adding, all, attached, query]);

  /** Exactly matching an existing tag means Enter attaches it rather than offering to create it. */
  const exactMatch = useMemo(
    () => all.find((t) => t.name.trim().toLowerCase() === query) ?? null,
    [all, query],
  );

  async function attach(payload: { tagId?: string; name?: string }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTempUser("/api/tags/assignments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetKind, targetId, ...payload }),
      });
      const json = (await res.json().catch(() => null)) as { tags?: Tag[]; error?: string } | null;
      if (!res.ok) throw new Error(json?.error || "Could not add the tag");
      setTags(Array.isArray(json?.tags) ? json!.tags! : []);
      setDraft("");
      // A tag created here belongs in the suggestions for the next one, without a refetch.
      setAll((prev) => {
        const next = Array.isArray(json?.tags) ? json!.tags! : [];
        const known = new Set(prev.map((t) => t.id));
        return [...prev, ...next.filter((t) => !known.has(t.id))];
      });
      inputRef.current?.focus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the tag");
    } finally {
      setBusy(false);
    }
  }

  async function detach(tagId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Optimistic: removing a tag is trivially undoable by typing it again, and the wait is what
    // makes a chip row feel heavy.
    const before = tags ?? [];
    setTags(before.filter((t) => t.id !== tagId));
    try {
      const res = await fetchWithTempUser("/api/tags/assignments", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetKind, targetId, tagId }),
      });
      if (!res.ok) throw new Error("Could not remove the tag");
      const json = (await res.json().catch(() => null)) as { tags?: Tag[] } | null;
      if (Array.isArray(json?.tags)) setTags(json!.tags!);
    } catch (e) {
      setTags(before);
      setError(e instanceof Error ? e.message : "Could not remove the tag");
    } finally {
      setBusy(false);
    }
  }

  // Nothing at all until the first read lands: an empty "Tags" label that then fills in reads as a
  // page that lost something.
  if (tags === null) return null;

  const showEmpty = !tags.length && !adding;

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag.id}
            className="group inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--panel)] py-1 pl-2.5 pr-2 text-[12px] font-medium text-[var(--fg)]"
          >
            <TagDot color={tag.color} />
            <span className="truncate">{tag.name}</span>
            {canManage ? (
              <button
                type="button"
                onClick={() => void detach(tag.id)}
                disabled={busy}
                aria-label={`Remove tag ${tag.name}`}
                title="Remove"
                className="-mr-0.5 rounded-full p-0.5 text-[var(--muted-2)] opacity-0 transition-opacity hover:text-[var(--fg)] focus:opacity-100 group-hover:opacity-100 disabled:opacity-40"
              >
                <XMarkIcon className="h-3 w-3" />
              </button>
            ) : null}
          </span>
        ))}

        {canManage && !adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--border)] px-2.5 py-1 text-[12px] font-medium text-[var(--muted)] transition-colors hover:border-[var(--muted-2)] hover:text-[var(--fg)]"
          >
            <PlusIcon className="h-3 w-3" aria-hidden="true" />
            {showEmpty ? "Add a tag" : "Tag"}
          </button>
        ) : null}
      </div>

      {adding ? (
        <div className="relative mt-2">
          <input
            ref={inputRef}
            value={draft}
            maxLength={NAME_MAX}
            disabled={busy}
            placeholder="Type a tag, press Enter"
            aria-label="Add a tag"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1.5 text-[13px] text-[var(--fg)] outline-none placeholder:text-[var(--muted-2)] focus:ring-2 focus:ring-[var(--ring)]"
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const name = draft.trim();
                if (!name) return;
                // An exact match attaches the tag that exists; anything else is find-or-create on
                // the server, which folds case and punctuation the same way.
                void attach(exactMatch ? { tagId: exactMatch.id } : { name });
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraft("");
                setAdding(false);
                setError(null);
              }
            }}
            onBlur={() => {
              // Closing on blur would eat a click on a suggestion; only an empty box closes.
              if (!draft.trim()) setAdding(false);
            }}
          />

          {suggestions.length ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {suggestions.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  disabled={busy}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void attach({ tagId: tag.id })}
                  className="inline-flex max-w-[200px] items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1 text-[12px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--fg)] disabled:opacity-50"
                >
                  <TagDot color={tag.color} />
                  <span className="truncate">{tag.name}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? <div className="mt-1.5 text-[12px] font-medium text-red-600">{error}</div> : null}
    </div>
  );
}
