import { CheckIcon } from "@heroicons/react/24/outline";

/** The sign-in path: add, sign in, verify. */
export const SIGN_IN_STEPS = ["Add lnkdrp to your client", "Sign in when it asks", "Verify"] as const;
/** The key path: create, add with the key, verify. */
export const KEY_STEPS = ["Create a key", "Add lnkdrp to your client", "Verify"] as const;

/**
 * The three-step rail at the top of the Connect page. `steps` follows the chosen path; `current`
 * is 1-based; `done` marks every step complete (the workspace has a connected agent).
 */
export default function StepsRail({ steps, current, done }: { steps: readonly string[]; current: 1 | 2 | 3; done: boolean }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-6 gap-y-2" aria-label="Setup steps">
      {steps.map((label, i) => {
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
