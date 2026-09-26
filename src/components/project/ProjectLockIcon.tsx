/**
 * The padlock beside a private data room's name (docs/prds/lnkdrp-locked-projects.md).
 *
 * Slack solved this and taught a generation of people what the lock means: this room exists for the
 * people in it. So a locked room carries one wherever it is named — the sidebar row, the project
 * header, a document's project pill, every picker — and the people who are in it can see at a glance
 * that others are not.
 *
 * One component rather than five copies, for the reason the rest of this feature is one helper: a
 * padlock that appears in four places out of five reads as a bug in the fifth, and the sizes and
 * colours would drift the first time a row's type scale changed. It renders nothing when the room is
 * not locked, so callers can drop it in unconditionally.
 */
import { LockClosedIcon } from "@heroicons/react/24/outline";

/**
 * A `<select>` cannot hold an icon, so a picker's options say it in words instead.
 *
 * The same sentence the dialogs use: "private", not "locked". The padlock is the icon and "private"
 * is what a person calls the thing the icon means.
 */
export function lockedOptionLabel(name: string, locked: boolean): string {
  return locked ? `${name} (private)` : name;
}

export default function ProjectLockIcon({
  locked,
  className = "h-3.5 w-3.5",
  title = "Private data room: only its members can see it",
}: {
  /** Pass `project.visibility === "locked"`, or the flag a caller already computed. */
  locked: boolean | undefined;
  /** Size and colour classes, so each row can match the icons beside it. */
  className?: string;
  title?: string;
}) {
  if (!locked) return null;
  return (
    <LockClosedIcon
      className={["shrink-0 text-[var(--muted-2)]", className].join(" ")}
      title={title}
      // Not `aria-hidden`: unlike the folder glyph beside it, this one carries meaning a screen
      // reader has no other way to reach, because "private" appears nowhere in the row's text.
      role="img"
      aria-label={title}
    />
  );
}
