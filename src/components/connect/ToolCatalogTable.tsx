import { TOOL_CATALOG } from "@/lib/mcp/clientSetups";

/**
 * Compact table of the MCP tool catalog: name, one-line purpose, read/write. Shared by `/connect`
 * and the public `/mcp` overview; renders on the app tokens so it works on both grounds.
 */
export default function ToolCatalogTable() {
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
                <span
                  className={[
                    "inline-flex rounded-md px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.1em] ring-1 ring-[var(--border)]",
                    t.access === "write" ? "bg-[var(--panel-hover)] text-[var(--fg)]" : "text-[var(--muted-2)]",
                  ].join(" ")}
                >
                  {t.access}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
