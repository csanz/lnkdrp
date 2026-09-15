import { TOOL_CATALOG, type ToolCatalogEntry } from "@/lib/mcp/clientSetups";

/**
 * The MCP tool catalog: every tool, with its full reference one click away.
 *
 * Shared by `/connect` and the public `/mcp` overview; renders on the app tokens so it works on
 * both grounds. Each row shows the name, a one-line purpose and read/write at a glance — that is
 * the scanning view — and opens into the inputs, output, errors and one note when someone wants
 * to know what a tool actually takes and returns. Until this, that detail lived only in a repo
 * file no user could see, and the web told them "Delete one link" and nothing more.
 *
 * `layout="table"` (default) is for wide containers. `layout="stack"` puts the name and access on
 * one row and the purpose underneath, for narrow containers such as the side column on `/connect`
 * at xl widths. Both layouts open the same detail.
 *
 * Native `<details>`: no state, works without JavaScript, and the browser handles keyboard and
 * screen-reader semantics. Tools that confirm with the human carry a visible mark, because that
 * is the one behaviour a person should be able to see before they let an agent loose.
 */
export default function ToolCatalogTable({ layout = "table" }: { layout?: "table" | "stack" }) {
  if (layout === "stack") {
    return (
      <ul className="divide-y divide-[var(--border)] text-[13px]">
        {TOOL_CATALOG.map((t) => (
          <li key={t.name} className="py-2.5 first:pt-0 last:pb-0">
            <details className="group">
              <summary className="flex cursor-pointer select-none list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 truncate font-mono text-[12px] text-[var(--fg)]">{t.name}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {t.confirms ? <ConfirmsPill /> : null}
                  <AccessPill access={t.access} />
                  <Chevron />
                </span>
              </summary>
              <p className="mt-0.5 leading-5 text-[var(--muted)]">{t.purpose}</p>
              <ToolDetail entry={t} />
            </details>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="divide-y divide-[var(--border)] text-[13px]">
      <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)_auto] gap-x-4 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-2)]">
        <span>Tool</span>
        <span>What it does</span>
        <span className="text-right">Access</span>
      </div>
      {TOOL_CATALOG.map((t) => (
        <details key={t.name} className="group">
          <summary className="grid cursor-pointer select-none list-none grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)_auto] items-start gap-x-4 py-2.5 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 truncate font-mono text-[12px] leading-5 text-[var(--fg)]">{t.name}</span>
            <span className="leading-5 text-[var(--muted)]">{t.purpose}</span>
            <span className="flex items-center justify-end gap-1.5">
              {t.confirms ? <ConfirmsPill /> : null}
              <AccessPill access={t.access} />
              <Chevron />
            </span>
          </summary>
          <div className="pb-3 pl-0 sm:pl-[calc(100%/3.1*1.1+1rem)]">
            <ToolDetail entry={t} />
          </div>
        </details>
      ))}
    </div>
  );
}

/** The reference for one tool: what it takes, what it returns, how it fails. */
function ToolDetail({ entry }: { entry: ToolCatalogEntry }) {
  const d = entry.detail;
  return (
    <div className="mt-2 grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3.5 text-[12px] leading-5 text-[var(--muted)]">
      <Block label="Inputs">
        <ul className="grid gap-1">
          {d.inputs.map((line) => (
            <li key={line} className="flex gap-2">
              <span aria-hidden="true" className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-[var(--muted-2)]" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </Block>
      <Block label="Returns">
        <p>{d.output}</p>
      </Block>
      <Block label="Errors">
        <ul className="grid gap-1">
          {d.errors.map((line) => (
            <li key={line} className="flex gap-2">
              <span aria-hidden="true" className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-[var(--muted-2)]" />
              <span>
                <code className="font-mono text-[11px] text-[var(--fg)]">{line.split(" — ")[0]}</code>
                {line.includes(" — ") ? <span> — {line.split(" — ").slice(1).join(" — ")}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </Block>
      {d.note ? (
        <Block label={entry.confirms ? "Asks you first" : "Worth knowing"}>
          <p className={entry.confirms ? "text-[var(--fg)]" : undefined}>{d.note}</p>
        </Block>
      ) : null}
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-2)]">{label}</div>
      {children}
    </div>
  );
}

function Chevron() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0 text-[var(--muted-2)] transition-transform group-open:rotate-180"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Marks a tool that confirms with the human before acting — the one behaviour to see up front. */
function ConfirmsPill() {
  return (
    <span
      className="inline-flex shrink-0 rounded-md px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.1em] text-amber-700 ring-1 ring-amber-500/40 dark:text-amber-300"
      title="Asks you to confirm before doing anything irreversible"
    >
      asks first
    </span>
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
