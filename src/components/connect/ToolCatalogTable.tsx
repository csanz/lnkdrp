import { TOOL_CATALOG } from "@/lib/mcp/clientSetups";

/**
 * The MCP tool catalog: name, one-line purpose, read/write. Shared by `/connect` and the public
 * `/mcp` overview; renders on the app tokens so it works on both grounds.
 *
 * `layout="table"` (default) is the three-column table for wide containers. `layout="stack"` puts
 * the name and access on one row and the purpose underneath, for narrow containers such as the
 * side column on `/connect` at xl widths, where a three-column table would wrap every cell.
 */
export default function ToolCatalogTable({ layout = "table" }: { layout?: "table" | "stack" }) {
  if (layout === "stack") {
    return (
      <ul className="divide-y divide-[var(--border)] text-[13px]">
        {TOOL_CATALOG.map((t) => (
          <li key={t.name} className="py-2.5 first:pt-0 last:pb-0">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate font-mono text-[12px] text-[var(--fg)]">{t.name}</span>
              <AccessPill access={t.access} />
            </div>
            <p className="mt-0.5 leading-5 text-[var(--muted)]">{t.purpose}</p>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-2)]">
            <th className="pb-2 pr-4 font-semibold">Tool</th>
            <th className="pb-2 pr-4 font-semibold">What it does</th>
            <th className="pb-2 text-right font-semibold">Access</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)]">
          {TOOL_CATALOG.map((t) => (
            <tr key={t.name}>
              <td className="whitespace-nowrap py-2.5 pr-4 align-top font-mono text-[12px] text-[var(--fg)]">{t.name}</td>
              <td className="py-2.5 pr-4 align-top leading-5 text-[var(--muted)]">{t.purpose}</td>
              <td className="whitespace-nowrap py-2.5 text-right align-top">
                <AccessPill access={t.access} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AccessPill({ access }: { access: "read" | "write" }) {
  return (
    <span
      className={[
        "inline-flex shrink-0 rounded-md px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.1em] ring-1 ring-[var(--border)]",
        access === "write" ? "bg-[var(--panel-hover)] text-[var(--fg)]" : "text-[var(--muted-2)]",
      ].join(" ")}
    >
      {access}
    </span>
  );
}
