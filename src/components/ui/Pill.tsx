/**
 * Small inline UI pill used for compact metadata badges.
 */
export default function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1 text-[12px] font-semibold text-[var(--muted-2)]">
      {children}
    </span>
  );
}

