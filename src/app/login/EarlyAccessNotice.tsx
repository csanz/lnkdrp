"use client";

/**
 * Says that signing in joins a queue, before the person signs in.
 *
 * Fixed at the top of `/login` rather than inside the card, because the card belongs to a client
 * component that cannot read the server-only flag. What matters is that it is read before the
 * button, not that it sits in any particular box.
 *
 * Renders nothing when the queue is off, so turning it off needs no second edit here.
 */
export function EarlyAccessNotice({ queued }: { queued: boolean }) {
  if (!queued) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-center px-4 pt-20 sm:pt-24">
      <p className="pointer-events-auto max-w-md rounded-full border border-[var(--border)] bg-[var(--panel)]/90 px-4 py-1.5 text-center text-[12px] leading-5 text-[var(--muted)] shadow-lg backdrop-blur-sm">
        lnkdrp is in early access. Signing in puts you on the list; we let people in a few at a time.
      </p>
    </div>
  );
}
