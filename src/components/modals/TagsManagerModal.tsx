/**
 * Managing tags, in a modal from the sidebar.
 *
 * The same place Starred and Projects open their full lists from, and for the same reason: tags
 * are workspace content, not a setting. Nobody goes to Preferences to tidy a tag — they are
 * looking at the sidebar, see two spellings of the same word, and want to fix it where they are,
 * without losing the document they had open.
 */
"use client";

import Modal from "@/components/modals/Modal";
import TagsManager from "@/components/tags/TagsManager";

export default function TagsManagerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="Manage tags"
      panelClassName="w-[min(720px,calc(100vw-32px))]"
    >
      <div className="text-base font-semibold text-[var(--fg)]">Tags</div>
      <div className="mt-1 text-[13px] text-[var(--muted)]">
        Every tag in this workspace, and what carries it. Renaming or merging changes it everywhere.
      </div>

      <div className="mt-4 max-h-[min(60vh,560px)] overflow-auto">
        <TagsManager />
      </div>
    </Modal>
  );
}
