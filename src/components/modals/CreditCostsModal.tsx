"use client";

/**
 * "What actions cost": the credit price of every AI action at each quality level.
 *
 * Opened from the Usage tab, and from an action name in the usage list (that row's entry is
 * highlighted, so "why did this cost 2 credits" is one click from the charge). Wider than the
 * app's usual modal because it holds a four-column table.
 */
import Modal from "@/components/modals/Modal";
import {
  COST_CATALOG,
  FREE_ACTIONS,
  QUALITY_BLURBS,
  QUALITY_LABELS,
  QUALITY_TIERS,
} from "@/lib/credits/costCatalog";
import type { ActionType } from "@/lib/credits/types";

export default function CreditCostsModal({
  open,
  onClose,
  highlightAction,
  creditsRemaining,
}: {
  open: boolean;
  onClose: () => void;
  /** The usage row's action, when opened from the list. */
  highlightAction?: ActionType | null;
  /** Shown as context, when the page has it. */
  creditsRemaining?: number | null;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="What actions cost"
      panelClassName="w-[min(900px,calc(100vw-32px))]"
      contentClassName="max-h-[min(86vh,900px)] overflow-auto px-6 pb-6 pt-5"
    >
      <div className="pr-10">
        <div className="text-base font-semibold text-[var(--fg)]">What actions cost</div>
        <div className="mt-1 text-[13px] leading-5 text-[var(--muted-2)]">
          Credits are only spent when AI reads a document. Every run is listed on this page with the level it ran at.
          {typeof creditsRemaining === "number" ? ` You have ${creditsRemaining} left.` : ""}
        </div>
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="align-bottom text-[12px] font-semibold text-[var(--muted-2)]">
              <th className="pb-3 pr-4">Per run</th>
              {QUALITY_TIERS.map((t) => (
                <th key={t} className="w-[16%] pb-3 pl-4 text-right">
                  <div className="text-[var(--fg)]">{QUALITY_LABELS[t]}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COST_CATALOG.map((row) => {
              const highlighted = Boolean(highlightAction && row.action === highlightAction);
              return (
                <tr
                  key={row.label}
                  className={[
                    "border-t border-[var(--border)] align-top",
                    highlighted ? "bg-[var(--panel-hover)]" : "",
                    row.released ? "" : "text-[var(--muted-2)]",
                  ].join(" ")}
                >
                  <td className="py-3 pr-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={row.released ? "font-semibold text-[var(--fg)]" : "font-semibold"}>{row.label}</span>
                      {row.released ? null : (
                        <span className="rounded-full border border-[var(--border)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">
                          Not available yet
                        </span>
                      )}
                      {highlighted ? (
                        <span className="rounded-full bg-[var(--fg)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--bg)]">
                          This charge
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 text-[12px] leading-5 text-[var(--muted-2)]">{row.detail}</div>
                    {row.notes?.length ? (
                      <ul className="mt-1.5 space-y-1 text-[12px] leading-5 text-[var(--muted-2)]">
                        {row.notes.map((n) => (
                          <li key={n} className="flex gap-1.5">
                            <span aria-hidden="true">·</span>
                            <span>{n}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                  {QUALITY_TIERS.map((t) => (
                    <td key={t} className="py-3 pl-4 text-right tabular-nums">
                      <span className={row.released ? "text-[var(--fg)]" : ""}>{row.costs[t]}</span>{" "}
                      <span className="text-[var(--muted-2)]">{row.costs[t] === 1 ? "credit" : "credits"}</span>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
          <div className="text-[12px] font-semibold text-[var(--fg)]">What the levels mean</div>
          <dl className="mt-2 space-y-2 text-[12px] leading-5 text-[var(--muted-2)]">
            {QUALITY_TIERS.map((t) => (
              <div key={t}>
                <dt className="font-semibold text-[var(--fg)]">{QUALITY_LABELS[t]}</dt>
                <dd>{QUALITY_BLURBS[t]}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
          <div className="text-[12px] font-semibold text-[var(--fg)]">Never costs credits</div>
          <ul className="mt-2 space-y-1 text-[12px] leading-5 text-[var(--muted-2)]">
            {FREE_ACTIONS.map((f) => (
              <li key={f} className="flex gap-1.5">
                <span aria-hidden="true">·</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
