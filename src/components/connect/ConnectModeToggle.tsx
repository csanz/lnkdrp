"use client";

/**
 * The one choice on the Connect page: sign in from the client, or paste a key. Everything below
 * it (the step rail, the panels, the commands) follows this. Sign in is the recommended default;
 * a client that can only send a header (Grok) forces the key path, and the toggle says so rather
 * than offering a choice that cannot be taken.
 */
export type ConnectMode = "signin" | "key";

export default function ConnectModeToggle({
  mode,
  onChange,
  signInAvailable,
  clientLabel,
}: {
  mode: ConnectMode;
  onChange: (mode: ConnectMode) => void;
  /** False for a client with no sign-in path; the toggle then shows the key path as the only one. */
  signInAvailable: boolean;
  clientLabel: string;
}) {
  const options = [
    { id: "signin" as const, label: "Sign in", hint: "Recommended", disabled: !signInAvailable },
    { id: "key" as const, label: "Use a key", hint: "Scripts, no browser", disabled: false },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="text-[12px] font-medium uppercase tracking-[0.12em] text-[var(--muted-2)]">How to connect</span>
      <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="How to connect">
        {options.map((opt) => {
          const selected = opt.id === mode;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={opt.disabled}
              onClick={() => onChange(opt.id)}
              title={opt.disabled ? `${clientLabel} cannot sign in; it takes a key.` : undefined}
              className={[
                "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[12px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
                selected ? "border-[var(--fg)] bg-[var(--fg)] text-[var(--bg)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]",
              ].join(" ")}
            >
              {opt.label}
              <span className={["text-[10px] font-semibold uppercase tracking-[0.1em]", selected ? "text-[var(--bg)]/70" : "text-[var(--muted-2)]"].join(" ")}>{opt.hint}</span>
            </button>
          );
        })}
      </div>
      {!signInAvailable ? <span className="text-[12px] text-[var(--muted-2)]">{clientLabel} takes a key only.</span> : null}
    </div>
  );
}
