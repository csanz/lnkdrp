/**
 * "Introduced themselves" — the tag that says where a name on an anonymous row came from.
 *
 * Two very different rows can end up with the same name on them. One is a reader who signed in, so
 * the name is their account's and we know it is theirs. The other is someone who arrived as a
 * device with no identity at all, saw the "introduce yourself" card, and typed it in. Without a
 * mark, the second looked exactly like the first — and a sender reading the page had no way to
 * tell a verified account from a line a stranger typed into a box.
 *
 * It is also the more interesting of the two. Volunteering a name is an act: this person decided
 * they wanted to be known to you, which is usually the warmest signal on the page.
 *
 * Deliberately not a claim about the address being real. The chip says they chose to tell you, and
 * the tooltip says the rest.
 */
export default function IntroducedBadge({ className }: { className?: string }) {
  return (
    <span
      title="They arrived anonymously and chose to tell you who they are. Typed in by them, not verified."
      className={[
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--muted)]",
        className ?? "",
      ].join(" ")}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" className="h-2.5 w-2.5">
        <path
          d="M8 8.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Zm-5 4.75c0-2.2 2.24-3.5 5-3.5s5 1.3 5 3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      Introduced themselves
    </span>
  );
}
