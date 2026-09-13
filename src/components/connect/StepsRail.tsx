import { CheckIcon } from "@heroicons/react/24/outline";

const STEPS = ["Create a key", "Add lnkdrp to your client", "Verify"] as const;

/**
 * The three-step rail at the top of the Connect page. `current` is 1-based; `done` marks every
 * step complete (the workspace has a connected agent).
 */
export default function StepsRail({ current, done }: { current: 1 | 2 | 3; done: boolean }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-6 gap-y-2" aria-label="Setup steps">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const complete = done || n < current;
        const active = !done && n === current;
        return (
          <li key={label} className="flex items-center gap-2.5" aria-current={active ? "step" : undefined}>
            <span
              aria-hidden="true"
              className={[
                "grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold tabular-nums",
                complete
                  ? "bg-[var(--fg)] text-[var(--bg)]"
                  : active
                    ? "border border-[var(--fg)] text-[var(--fg)]"
                    : "border border-[var(--border)] text-[var(--muted-2)]",
              ].join(" ")}
            >
              {complete ? <CheckIcon className="h-3.5 w-3.5" strokeWidth={2.5} /> : n}
            </span>
            <span
              className={[
                "text-[13px]",
                active ? "font-semibold text-[var(--fg)]" : complete ? "font-medium text-[var(--muted)]" : "text-[var(--muted-2)]",
              ].join(" ")}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
