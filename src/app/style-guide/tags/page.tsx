/**
 * Design preview at `/style-guide/tags`: how tags would read in the left menu.
 *
 * Nothing here touches product code or data — the rows, names and counts are hard-coded, and no
 * tag model exists yet (docs/prds/lnkdrp-tags.md, metis prd_5sIwl5b01z). It exists so the choice
 * between a tag pill and a tag dot can be made by looking at it at real sidebar width with real
 * project names, rather than from a description. Lives under /style-guide with the other previews
 * so design spikes have one home instead of a page at the root for each; delete once tags ship.
 */


import { FolderIcon } from "@heroicons/react/24/outline";

const SIDEBAR_WIDTH = 312;

/** The palette a tag would draw from; assigned in creation order rather than chosen, for now. */
const TAG_COLORS: Record<string, string> = {
  Fundraising: "#34d399",
  "Q3 2026": "#60a5fa",
  Diligence: "#f59e0b",
  Legal: "#f472b6",
  Customers: "#a78bfa",
};

type Row = { name: string; docs: number; tags: string[] };

/** Short names, as in a real workspace; and long ones, where a pill runs out of room. */
const SHORT: Row[] = [
  { name: "Data room", docs: 2, tags: ["Fundraising"] },
  { name: "Quarterly updates", docs: 4, tags: ["Fundraising", "Q3 2026"] },
  { name: "Board", docs: 3, tags: ["Diligence", "Legal"] },
];

const LONG: Row[] = [
  { name: "MCPTEST r2-projects Series A data room", docs: 4, tags: ["Fundraising"] },
  { name: "MCPTEST r2-projects Board Q3 2026", docs: 4, tags: ["Fundraising", "Q3 2026"] },
  { name: "MCPTEST r2-projects Customer case studies", docs: 4, tags: ["Customers"] },
];

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="flex h-7 items-center gap-1 pl-2 pr-2 text-[11px] font-semibold uppercase leading-5 tracking-[0.08em] text-[var(--muted-2)]">
      <span className="px-1">{label}</span>
    </div>
  );
}

function ProjectRow({ row, variant }: { row: Row; variant: "pill" | "dots" | "none" }) {
  return (
    <div className="block w-full cursor-default rounded-xl pl-3 pr-2 py-1.5 text-left text-[14px] hover:bg-[var(--sidebar-hover)]">
      <div className="flex min-w-0 items-center gap-2 pr-6 leading-normal">
        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
        <span className="block min-w-0 flex-1 truncate text-[var(--fg)]">{row.name}</span>
        {variant === "pill"
          ? row.tags.slice(0, 2).map((t) => (
              <span
                key={t}
                className="shrink-0 whitespace-nowrap rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-[1px] text-[10px] font-medium text-[var(--muted-2)]"
              >
                {t}
              </span>
            ))
          : null}
        {variant === "dots" ? (
          <span className="flex shrink-0 items-center gap-1">
            {row.tags.slice(0, 3).map((t) => (
              <span
                key={t}
                title={t}
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: TAG_COLORS[t] ?? "#9ca3af", opacity: 0.9 }}
              />
            ))}
          </span>
        ) : null}
        <span className="shrink-0 text-[11px] font-medium tabular-nums text-[var(--muted-2)] opacity-70">{row.docs}</span>
      </div>
    </div>
  );
}

function TagsSection() {
  const tags: Array<[string, number]> = [
    ["Fundraising", 6],
    ["Q3 2026", 4],
    ["Diligence", 3],
    ["Legal", 2],
    ["Customers", 2],
  ];
  return (
    <div className="mt-4">
      <SectionHeader label="Tags" />
      <div className="mt-2 space-y-1">
        {tags.map(([name, count]) => (
          <div
            key={name}
            className="block w-full cursor-default rounded-xl pl-3 pr-2 py-1.5 text-left text-[14px] hover:bg-[var(--sidebar-hover)]"
          >
            <div className="flex min-w-0 items-center gap-2 pr-6 leading-normal">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TAG_COLORS[name] }} aria-hidden="true" />
              <span className="block min-w-0 flex-1 truncate text-[var(--fg)]">{name}</span>
              <span className="shrink-0 text-[11px] font-medium tabular-nums text-[var(--muted-2)] opacity-70">{count}</span>
            </div>
          </div>
        ))}
        <div className="pl-3 pr-2 py-1 text-[13px] font-medium text-[var(--muted)]">See more</div>
      </div>
    </div>
  );
}

function Column({
  title,
  note,
  rows,
  variant,
  withTagsSection,
}: {
  title: string;
  note: string;
  rows: Row[];
  variant: "pill" | "dots" | "none";
  withTagsSection?: boolean;
}) {
  return (
    <div style={{ width: SIDEBAR_WIDTH }} className="shrink-0">
      <div className="mb-1 pl-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-2)]">{title}</div>
      <div className="mb-3 pl-3 text-[12px] leading-4 text-[var(--muted-2)] opacity-70">{note}</div>
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--sidebar-bg)] py-3 pl-3 pr-12">
        <SectionHeader label="Projects" />
        <div className="mt-2 space-y-1">
          {rows.map((r) => (
            <ProjectRow key={r.name} row={r} variant={variant} />
          ))}
        </div>
        {withTagsSection ? <TagsSection /> : null}
      </div>
    </div>
  );
}

export default function TagsPreviewPage() {
  return (
    <div className="px-6 py-8">
      <h1 className="text-lg font-semibold tracking-tight text-[var(--fg)]">Tags in the left menu: preview</h1>
      <p className="mt-1 max-w-2xl text-[13px] leading-5 text-[var(--muted)]">
        Fake names, fake tags, no data model: a design preview only, at the sidebar&apos;s real width (312px). Compare how each
        variant holds up against short project names and long ones, then the dots together with a Tags section, which is what
        makes a coloured dot legible.
      </p>

      <div className="mt-8 flex flex-wrap gap-10">
        <Column title="Today" note="No tags" rows={SHORT} variant="none" />
        <Column title="Variant A: pill" note="Reads instantly, costs name width" rows={SHORT} variant="pill" />
        <Column title="Variant B: dots" note="Never truncates, needs the section below" rows={SHORT} variant="dots" withTagsSection />
      </div>

      <h2 className="mt-12 text-[13px] font-semibold text-[var(--fg)]">The same two, with long project names</h2>
      <div className="mt-4 flex flex-wrap gap-10">
        <Column title="Variant A: pill" note="Name truncates earlier with every tag" rows={LONG} variant="pill" />
        <Column title="Variant B: dots" note="Name keeps the space it has today" rows={LONG} variant="dots" />
      </div>
    </div>
  );
}
