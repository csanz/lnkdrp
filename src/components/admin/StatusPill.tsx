/**
 * StatusPill — a state reads as a state.
 *
 * Use a pill when the value is a state an admin scans for (live / revoked / failed /
 * Pro). Use `BoolState` for a plain flag: the true case gets a quiet pill, the false
 * case gets a dash, because a column of "No" is noise.
 */
"use client";

import { cn } from "@/lib/cn";
import { ADMIN_DASH, statusLabel, toneStyle, type AdminTone } from "@/lib/admin/ui";

export type StatusPillProps = {
  children: React.ReactNode;
  /** Colour is meaning: positive = live/ok, warning = attention, danger = failed/revoked. */
  tone?: AdminTone;
  /** A 5px dot before the label — for live/offline style states. */
  dot?: boolean;
  title?: string;
  className?: string;
};

/** A small chip that reads as a state. Tone carries meaning, never decoration. */
export default function StatusPill({ children, tone = "neutral", dot = false, title, className }: StatusPillProps) {
  return (
    <span
      title={title}
      style={toneStyle(tone)}
      className={cn(
        // 16px line + 1px padding + 1px border = a 20px chip, so a cell holding one is the
        // same height as a cell holding a line of text and every admin row is 41px.
        "inline-flex max-w-full items-center gap-1.5 truncate rounded-md border px-1.5 py-px text-[11.5px] font-medium leading-4",
        className,
      )}
    >
      {dot ? <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-80" /> : null}
      {/* Stored statuses arrive lowercase (`ready`, `charged`, `ok`) while hand-written
          labels are capitalised. Sentence-casing here means one vocabulary on screen and
          no `className="capitalize"` overrides scattered across the pages. */}
      <span className="truncate">{typeof children === "string" ? statusLabel(children) : children}</span>
    </span>
  );
}

export type BoolStateProps = {
  value: boolean | null | undefined;
  /** Label for the true case, e.g. "Temp". */
  trueLabel: string;
  /** Label for the false case. Omit to render a dash instead — the usual choice. */
  falseLabel?: string;
  trueTone?: AdminTone;
  falseTone?: AdminTone;
};

/** A boolean field. `true` gets a pill, `false` gets a dash unless you name it. */
export function BoolState({
  value,
  trueLabel,
  falseLabel,
  trueTone = "neutral",
  falseTone = "quiet",
}: BoolStateProps) {
  if (value) {
    return <StatusPill tone={trueTone}>{trueLabel}</StatusPill>;
  }
  if (!falseLabel) {
    // ARIA does not expose a name on a bare <span>, so `aria-label="No"` was silently
    // dropped and the cell read as an em dash or as nothing. Visually hidden text is
    // the only version a screen reader actually announces.
    return (
      <span className="text-[var(--muted-2)]">
        <span className="sr-only">No</span>
        <span aria-hidden="true">{ADMIN_DASH}</span>
      </span>
    );
  }
  return <StatusPill tone={falseTone}>{falseLabel}</StatusPill>;
}
