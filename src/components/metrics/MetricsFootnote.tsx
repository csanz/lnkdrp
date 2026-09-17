/**
 * Fine print under the metrics page: how people are counted and what the figures leave out.
 */

export type MetricsFootnoteProps = {
  deep: boolean;
  people: number | null;
  peopleWithDetail: number | null;
  multipleVersions: boolean;
  truncated: boolean;
  /** Your own previews in range; null when unknown. */
  ownerPreviews: number | null;
  /** Render nothing unless there is a line beyond the always-present counting note. */
  onlyExtra?: boolean;
};

/** Muted footnote lines. */
export default function MetricsFootnote({
  deep,
  people,
  peopleWithDetail,
  multipleVersions,
  truncated,
  ownerPreviews,
  onlyExtra = false,
}: MetricsFootnoteProps) {
  const lines = ["Someone who opened two links counts once per link."];
  if (deep && people !== null && peopleWithDetail !== null && peopleWithDetail < people) {
    lines.push(`Page detail for ${peopleWithDetail} of ${people} people.`);
  }
  if (multipleVersions) lines.push("Includes reads of earlier versions.");
  if (ownerPreviews !== null && ownerPreviews > 0) {
    lines.push(`${ownerPreviews} of your own previews not counted.`);
  }
  if (truncated) lines.push("Page detail is limited to the most recent activity.");
  if (onlyExtra && lines.length === 1) return null;
  return (
    <footer data-footnote className="space-y-0.5 pb-4 text-[12px] text-[var(--muted)]">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </footer>
  );
}
