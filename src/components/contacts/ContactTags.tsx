/**
 * The tags on one contact: the chips, an × to take one off, and the same picker a document uses.
 *
 * A tag on a person is how "investor", "passed", "warm" or "counsel" get said (docs/prds/
 * lnkdrp-contacts.md, decision 7); the product does not invent a status field. So this is
 * `TagsRow` in spirit and `TagPickerModal` in fact, with `targetKind: "contact"` and the contact's
 * id, so the tag page and the sidebar counts see a tagged person the same way they see a tagged
 * document.
 *
 * Why not `TagsRow` itself: the contact page arrives with the tags already on the row it fetched
 * (`ContactDetail.tags`), and a chip row that paints empty and then fills in reads as a page that
 * lost something. The initial tags are the first paint; the assignments route is still read once
 * behind them, because it is the authority and the page's copy may be a beat old.
 *
 * Writing takes the member role, the same role the note editor and the server check
 * (`forbidUnlessOrgRole`). `canManage` fails closed while the plan snapshot loads, so a viewer is
 * never shown a button the API will refuse.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";

import TagDot from "@/components/tags/TagDot";
import TagPickerModal from "@/components/tags/TagPickerModal";
import { usePlan } from "@/lib/client/usePlan";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import type { TagDTO } from "@/lib/tags/service";

const TARGET_KIND = "contact" as const;

export default function ContactTags({ contactId, initialTags }: { contactId: string; initialTags: TagDTO[] }) {
  const { plan } = usePlan();
  const canManage = plan ? plan.canManageLinks : false;
  const [tags, setTags] = useState<TagDTO[]>(initialTags);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The page's own copy wins until the route answers; a re-render with a fresher row keeps up.
  useEffect(() => {
    setTags(initialTags);
  }, [initialTags]);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ targetKind: TARGET_KIND, targetId: contactId });
      const res = await fetchWithTempUser(`/api/tags/assignments?${qs.toString()}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { tags?: TagDTO[] };
      if (Array.isArray(json.tags)) setTags(json.tags);
    } catch {
      // The initial tags stay; the picker reads the list again when it opens.
    }
  }, [contactId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function detach(tagId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Optimistic, as on a document: removing a tag is undone by picking it again, and the wait is
    // what makes a chip row feel heavy.
    const before = tags;
    setTags(before.filter((t) => t.id !== tagId));
    try {
      const res = await fetchWithTempUser("/api/tags/assignments", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetKind: TARGET_KIND, targetId: contactId, tagId }),
      });
      if (!res.ok) throw new Error("Could not remove the tag");
      const json = (await res.json().catch(() => null)) as { tags?: TagDTO[] } | null;
      if (Array.isArray(json?.tags)) setTags(json!.tags!);
      window.dispatchEvent(new Event("lnkdrp:tags-changed"));
    } catch (e) {
      setTags(before);
      setError(e instanceof Error ? e.message : "Could not remove the tag");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-contact-id={contactId}>
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
        ) : !tags.length ? (
          <span className="text-[13px] text-[var(--muted)]">No tags yet.</span>
        ) : null}
      </div>

      {canManage ? (
        <TagPickerModal
          open={picking}
          onClose={() => setPicking(false)}
          targetKind={TARGET_KIND}
          targetId={contactId}
          attached={tags}
          onChanged={(next) => setTags(next)}
        />
      ) : null}

      {error ? <div className="mt-1.5 text-[12px] font-medium text-red-600">{error}</div> : null}
    </div>
  );
}
