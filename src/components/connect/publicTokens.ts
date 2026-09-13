import type { CSSProperties } from "react";

/**
 * Pins the app's CSS-variable tokens to the always-dark public ground (`/mcp`, `/mcp/[client]`),
 * so the Connect components render correctly there whatever theme the visitor has chosen.
 * Same approach as `/about`, which pins `--fg` and `--muted` for `AboutCopy`.
 */
export const PUBLIC_DARK_TOKENS = {
  "--bg": "#050506",
  "--fg": "#ffffff",
  "--panel": "rgba(255,255,255,0.03)",
  "--panel-2": "rgba(255,255,255,0.06)",
  "--panel-hover": "rgba(255,255,255,0.08)",
  "--border": "rgba(255,255,255,0.10)",
  "--muted": "rgba(255,255,255,0.72)",
  "--muted-2": "rgba(255,255,255,0.5)",
  "--ring": "rgba(255,255,255,0.3)",
  "--primary-bg": "#ffffff",
  "--primary-fg": "#000000",
  "--primary-hover-bg": "#e4e4e7",
  "--primary-ring": "rgba(255,255,255,0.28)",
  "--primary-shadow": "rgba(255,255,255,0.14)",
} as CSSProperties;
