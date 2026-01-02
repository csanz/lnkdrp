"use client";

import Link from "next/link";
import { FolderIcon } from "@heroicons/react/24/outline";
import Modal from "@/components/modals/Modal";

export type DocProjectListItem = { id: string; name: string; slug?: string };
/**
 * Render the DocProjectsModal UI.
 */


export default function DocProjectsModal({
  open,
  projects,
  onClose,
}: {
  open: boolean;
  projects: DocProjectListItem[];
  onClose: () => void;
}) {
  const ps = Array.isArray(projects) ? projects : [];

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Projects">
      <div className="px-1 pb-3 text-base font-semibold text-zinc-900">
        Projects{ps.length ? ` (${ps.length})` : ""}
      </div>

      {!ps.length ? (
        <div className="mt-2 text-sm text-zinc-600">This document isn’t in any projects yet.</div>
      ) : (
        <ul className="mt-2 divide-y divide-zinc-200 overflow-hidden rounded-2xl border border-zinc-200">
          {ps.map((p) => {
            const href = p.id ? `/project/${encodeURIComponent(p.id)}` : null;
            const Row = (
              <div className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-zinc-50">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <FolderIcon className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                    <div className="truncate text-[13px] font-semibold text-zinc-900">{p.name}</div>
                  </div>
                </div>
              </div>
            );

            return (
              <li key={p.id}>
                {href ? (
                  <Link href={href} onClick={onClose} className="block">
                    {Row}
                  </Link>
                ) : (
                  Row
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}





