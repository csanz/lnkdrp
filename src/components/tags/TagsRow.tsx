/**
 * The tags on one document, project or contact.
 *
 * The chips themselves, with an × on hover to take one off, and a button that opens the picker
 * (`TagPickerModal`) for everything else. The inline suggestion box this used to carry worked for
 * six tags and hid the rest at sixty; the picker shows the whole list, ticks what is already on
 * this item, and lets you set several in one sitting — which is how tagging actually happens, in a
 * burst when a document lands rather than one tag per visit.
 *
 * Two shapes:
 *
 * - `panel` — full-size chips in a card, with an × on each.
 * - `header` — the compact row that sits beside a page title. Two chips and a "+2", never more:
 *   the title row is 32px on every page in the app, and a project with nine tags must not be the
 *   one page where the header is two lines tall. Removing happens in the picker there, since an ×
 *   at that size is a mis-click waiting to happen.
 *
 * Reading is open to any member; writing takes the same role the server enforces, and `canManage`
 * fails closed while the plan snapshot loads, so nobody is shown an input the API will refuse.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";

import TagDot from "@/components/tags/TagDot";
import TagPickerModal from "@/components/tags/TagPickerModal";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import type { TagTargetKind } from "@/lib/models/TagAssignment";
import type { TagColorKey } from "@/lib/tags/palette";

type Tag = { id: string; name: string; slug: string; color: TagColorKey; count?: number };
export type { TagTargetKind };

/** How many chips a header shows before the rest become "+N". */
const HEADER_VISIBLE = 2;

export default function TagsRow({
  targetKind,
  targetId,
  canManage = true,
  variant = "panel",
  className,
}: {
  targetKind: TagTargetKind;
  targetId: string;
  canManage?: boolean;
  variant?: "panel" | "header";
  className?: string;
}) {
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      window.dispatchEvent(new Event("lnkdrp:tags-changed"));
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

  if (variant === "header") {
    const shown = tags.slice(0, HEADER_VISIBLE);
    const extra = tags.length - shown.length;
    const all = tags.map((t) => t.name).join(" · ");

    return (
      <span className={["inline-flex min-w-0 items-center gap-1.5", className ?? ""].join(" ")}>
        {shown.map((tag) => (
          <button
            key={tag.id}
            type="button"
            onClick={() => canManage && setPicking(true)}
            title={canManage ? `${all}. Click to change` : all}
            className={[
              "inline-flex h-6 max-w-[160px] shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--panel)] px-2 text-[11px] font-medium text-[var(--muted)] transition-colors",
              canManage ? "hover:text-[var(--fg)]" : "cursor-default",
            ].join(" ")}
          >
            <TagDot color={tag.color} size={6} />
            <span className="truncate">{tag.name}</span>
          </button>
        ))}

        {extra > 0 ? (
          <button
            type="button"
            onClick={() => canManage && setPicking(true)}
            title={all}
            className="inline-flex h-6 shrink-0 items-center rounded-full border border-[var(--border)] bg-[var(--panel)] px-2 text-[11px] font-medium text-[var(--muted-2)] transition-colors hover:text-[var(--fg)]"
          >
            +{extra}
          </button>
        ) : null}

        {canManage ? (
          <button
            type="button"
            onClick={() => setPicking(true)}
            aria-label={tags.length ? "Change tags" : "Add a tag"}
            title={tags.length ? "Change tags" : "Add a tag"}
            className={[
              "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-dashed border-[var(--border)] text-[11px] font-medium text-[var(--muted-2)] transition-colors hover:border-[var(--muted-2)] hover:text-[var(--fg)]",
              // With no tags at all it says so; beside chips it is just a plus.
              tags.length ? "w-6 justify-center" : "px-2",
            ].join(" ")}
          >
            <PlusIcon className="h-3 w-3" aria-hidden="true" />
            {tags.length ? null : <span>Tag</span>}
          </button>
        ) : null}

        {canManage ? (
          <TagPickerModal
            open={picking}
            onClose={() => setPicking(false)}
            targetKind={targetKind}
            targetId={targetId}
            attached={tags}
            onChanged={(next) => setTags(next)}
          />
        ) : null}
      </span>
    );
  }

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

        {canManage ? (
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--border)] px-2.5 py-1 text-[12px] font-medium text-[var(--muted)] transition-colors hover:border-[var(--muted-2)] hover:text-[var(--fg)]"
          >
            <PlusIcon className="h-3 w-3" aria-hidden="true" />
            {tags.length ? "Tag" : "Add a tag"}
          </button>
        ) : null}
      </div>

      {canManage ? (
        <TagPickerModal
          open={picking}
          onClose={() => setPicking(false)}
          targetKind={targetKind}
          targetId={targetId}
          attached={tags}
          onChanged={(next) => setTags(next)}
        />
      ) : null}

      {error ? <div className="mt-1.5 text-[12px] font-medium text-red-600">{error}</div> : null}
    </div>
  );
}
