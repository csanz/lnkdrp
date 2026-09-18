/**
 * AdminAlert — the one message box the admin area uses for a fetch error or a write that
 * succeeded.
 *
 * Every admin page used to write `<Alert className="… text-red-700">`. `text-red-700` is
 * `#b91c1c`: on the dark `--panel` ground that is ~2.9:1, well under the 4.5:1 body text
 * needs, so every error message in the admin area was barely readable at night. The
 * emerald success variant was no better at ~3.4:1.
 *
 * `toneStyle()` mixes the hue against the theme's own `--fg` / `--panel`, so one
 * declaration is correct in light, dark and system-dark — the same rule every StatusPill
 * follows.
 */
"use client";

import { cn } from "@/lib/cn";
import { toneStyle, type AdminTone } from "@/lib/admin/ui";

export type AdminAlertProps = {
  children: React.ReactNode;
  /** `danger` for a failure, `positive` for a write that landed, `warning` for a caveat. */
  tone?: Extract<AdminTone, "danger" | "positive" | "warning" | "info" | "neutral">;
  /** Defaults to `alert` for danger and `status` for everything else. */
  role?: "alert" | "status";
  className?: string;
};

/** An inline admin message. Tone carries the meaning and stays legible in both themes. */
export default function AdminAlert({ children, tone = "danger", role, className }: AdminAlertProps) {
  return (
    <div
      role={role ?? (tone === "danger" ? "alert" : "status")}
      style={toneStyle(tone)}
      className={cn("rounded-xl border px-3.5 py-2.5 text-[13px] leading-5", className)}
    >
      {children}
    </div>
  );
}
