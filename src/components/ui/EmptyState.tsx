/**
 * Minimal shared empty state helper for dashboard tables/cards.
 *
 * NOTE: Keep copy passed in by callers so user-visible strings remain unchanged.
 */
export default function EmptyState({ text, className }: { text: string; className?: string }) {
  return <div className={className ?? "text-[12px] text-[var(--muted-2)]"}>{text}</div>;
}


