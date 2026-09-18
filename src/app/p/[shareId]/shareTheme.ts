/**
 * The forced-dark token set every `/p/**` surface paints itself with.
 *
 * Share pages must not follow the *owner's* theme preference — the recipient is a different person
 * on a different machine — so the tokens are inlined on the page's root element rather than
 * inherited. It lived copy-pasted in `page.tsx` and `loading.tsx`, which is exactly how a loading
 * shell ends up a different shade of black from the page it precedes; the nested document viewer
 * added a third copy. One export, three importers.
 */
import type { CSSProperties } from "react";

export const PROJECT_SHARE_THEME = {
  colorScheme: "dark",
  ["--bg" as keyof CSSProperties]: "#0b0b0c",
  ["--fg" as keyof CSSProperties]: "#e7e7ea",
  ["--panel" as keyof CSSProperties]: "#111113",
  ["--panel-2" as keyof CSSProperties]: "#151518",
  ["--panel-hover" as keyof CSSProperties]: "#1b1b1f",
  ["--border" as keyof CSSProperties]: "#2a2a31",
  ["--muted" as keyof CSSProperties]: "#b3b3bb",
  ["--muted-2" as keyof CSSProperties]: "#8b8b96",
} as CSSProperties;
