/**
 * Admin UI vocabulary: the shared rules every admin page renders by.
 *
 * This file holds the *values* (class strings, tones, formatters). The components in
 * `src/components/admin/` hold the *shapes*. Pages should not restate any of this
 * inline — if a page needs a class string that is not here, it belongs here.
 *
 * Rules encoded below:
 * - One text size for table body copy (13px/20px) and one for headers (11px, uppercase).
 * - Rows are one line: every cell is `whitespace-nowrap`; long text truncates, never wraps.
 * - Numbers, dates and counts are right-aligned and tabular.
 * - Colour is a state, never decoration: tones are mixed against `--fg`/`--panel` so a
 *   single declaration is correct in light, dark, and system-dark (where `dark:` does
 *   not apply because next-themes has not stamped `data-theme`).
 */

import type { CSSProperties } from "react";

/* ------------------------------------------------------------------ density */

/** Horizontal padding shared by every head and body cell, so columns line up. */
export const ADMIN_CELL_X = "px-2.5";

/** Vertical padding for a one-line body cell (20px line + 2×10px = 40px rows). */
export const ADMIN_CELL_Y = "py-2.5";

/**
 * Vertical padding for the cell holding a `RowActions` group.
 *
 * A `RowAction` is 26px. With the standard `py-2.5` that is a 46px row, so on every page
 * with row actions the buttons — not the type — set the rhythm. 6px here is a 38px cell
 * inside a 40px row, so tables with and without actions have the same pitch.
 */
export const ADMIN_ACTIONS_CELL_Y = "py-1.5";

/** Body text metrics for table cells. */
export const ADMIN_CELL_TEXT = "text-[13px] leading-5";

/** Header text metrics: small caps, never wrapped. */
export const ADMIN_HEAD_TEXT = "text-[11px] font-semibold uppercase tracking-[0.06em] leading-4";

/* ---------------------------------------------------------------- focus ring */

/**
 * The admin focus ring.
 *
 * `--ring` is still an alpha wash in dark (`#fff 20%`), which over a `--panel` row resolves to
 * roughly 1.8:1 — and since every admin control also sets `outline-none` there is no UA fallback.
 * WCAG 2.4.11 wants 3:1, so the ring is a real colour: `--fg` is near-black in light and
 * near-white in dark, which is >15:1 against both `--panel` and `--panel-2`. The offset keeps it
 * off the control's own border. (Light's `--ring` has since become a real colour too; dark's has
 * not, so this and `ADMIN_FOCUS_SCOPE` still earn their keep.)
 */
export const ADMIN_FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fg)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]";

/** Same ring, offset against the filter band's `--panel-2` ground. */
export const ADMIN_FOCUS_RING_BAND =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fg)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel-2)]";

/** Same ring for a control inside a clipped container (segmented groups), where an offset would be cut off. */
export const ADMIN_FOCUS_RING_INSET =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fg)]";

/**
 * The admin area's focus colour, applied to every focusable descendant of the page.
 *
 * The admin components above are fixed, but the admin pages also use the app-wide
 * `ui/Button` (every Refresh, the credits tools), and that primitive sets
 * `focus-visible:ring-[var(--ring)]` for the whole app — it cannot be re-pointed here
 * without changing every non-admin screen too. So the page container overrides the ring
 * *colour only* for what it contains: an inset ring stays inset, an offset ring keeps its
 * offset, and nothing in the admin area focuses with a 1.4:1 wash. `!` because the
 * descendant rule and the control's own `focus-visible:` utility have equal specificity.
 */
export const ADMIN_FOCUS_SCOPE = "[&_*:focus-visible]:ring-[var(--fg)]!";

/* ------------------------------------------------------------------ truncate */

/**
 * The wrapper `AdminTd truncate=` puts around a cell's contents.
 *
 * `truncate` alone only ellipsises *inline* content. A `<button>` or an `inline-flex`
 * span is an atomic inline-level box, so the browser clips it mid-glyph with no "…".
 * Capping and truncating direct element children too means the same prop works whether
 * the cell holds a string, a link, or a button.
 */
export const ADMIN_TRUNCATE_WRAP = "truncate [&>*]:max-w-full [&>*]:truncate";

/**
 * The left edge of a column pinned to the right of a scrolling table.
 *
 * Without it the pinned cell reads as part of the row and the column it covers looks
 * like corrupted data. The shadow says "content continues underneath"; it is mixed from
 * `--fg` so it is a dark edge in light mode and a light one in dark.
 */
export const ADMIN_STICKY_EDGE = "shadow-[-8px_0_10px_-8px_color-mix(in_srgb,var(--fg)_25%,transparent)]";

/* ----------------------------------------------------------------- alignment */

export type AdminAlign = "left" | "right" | "center";

/** Tailwind text alignment for a column. */
export function alignClass(align: AdminAlign = "left"): string {
  return align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
}

/* --------------------------------------------------------------------- tones */

/**
 * Semantic row/cell tones. `neutral` and `quiet` carry no hue — reach for a hue only
 * when the state itself is the message (live, revoked, failed, over limit).
 */
export type AdminTone = "neutral" | "quiet" | "positive" | "warning" | "danger" | "info" | "accent";

const TONE_HUE: Record<Exclude<AdminTone, "neutral" | "quiet">, string> = {
  positive: "#10b981",
  warning: "#f59e0b",
  danger: "#ef4444",
  info: "#3b82f6",
  accent: "#8b5cf6",
};

/**
 * Inline style for a toned chip. Mixing against the theme's own `--fg` / `--panel`
 * keeps one declaration legible on both grounds without a `dark:` variant.
 *
 * The hue's share of that mix is itself a token (`--tone-text-mix`). One weight could not serve
 * both themes: mixing a fixed slice of a *near-black* `--fg` into a mid-tone hue darkens it far
 * less than mixing the same slice of a *near-white* one lightens it, so at dark's weight the light
 * amber chip sat at 4.39:1 against dark's 8.68:1 — under AA for the 11px type these carry.
 */
export function toneStyle(tone: AdminTone): CSSProperties {
  if (tone === "neutral") {
    return {
      color: "var(--fg)",
      backgroundColor: "var(--panel-2)",
      borderColor: "var(--border)",
    };
  }
  if (tone === "quiet") {
    return {
      color: "var(--muted-2)",
      backgroundColor: "color-mix(in srgb, var(--panel-2) 70%, var(--panel))",
      borderColor: "var(--border)",
    };
  }
  const hue = TONE_HUE[tone];
  return {
    color: `color-mix(in srgb, ${hue} var(--tone-text-mix), var(--fg))`,
    backgroundColor: `color-mix(in srgb, ${hue} 13%, var(--panel))`,
    borderColor: `color-mix(in srgb, ${hue} 34%, var(--border))`,
  };
}

/** Text-only tone (a toned word inside a cell, no chip around it). */
export function toneTextStyle(tone: AdminTone): CSSProperties {
  if (tone === "neutral") return { color: "var(--fg)" };
  if (tone === "quiet") return { color: "var(--muted-2)" };
  return { color: `color-mix(in srgb, ${TONE_HUE[tone]} var(--tone-text-mix), var(--fg))` };
}

/* ----------------------------------------------------------------------- ids */

/**
 * Middle-truncate an opaque id: enough head to recognise it, enough tail to tell two
 * apart. Returns the input untouched when it is already short.
 */
export function truncateId(value: string, head = 6, tail = 4): string {
  const v = String(value ?? "");
  if (v.length <= head + tail + 1) return v;
  return `${v.slice(0, head)}…${v.slice(-tail)}`;
}

/* --------------------------------------------------------------------- dates */

/**
 * One-line admin timestamp: `17 Sep, 10:59`, or `17 Sep 2026, 10:59` outside the current
 * year. Seconds and the full value live in the cell's `title`, so nothing is lost and
 * nothing wraps — a date column must never be the reason a row needs two lines.
 */
export function fmtAdminDateTime(v: string | number | Date | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.valueOf())) return String(v);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Date only, for columns where the time of day is noise. */
export function fmtAdminDate(v: string | number | Date | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.valueOf())) return String(v);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Full, unambiguous value for a `title` attribute. */
export function fmtAdminDateFull(v: string | number | Date | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.valueOf())) return String(v);
  return d.toLocaleString();
}

/* -------------------------------------------------------------------- counts */

/** `1–50 of 312` — the one phrasing for "what am I looking at". */
export function rangeLabel(page: number, pageSize: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "0";
  const from = (Math.max(1, page) - 1) * pageSize + 1;
  const to = Math.min(total, Math.max(1, page) * pageSize);
  if (from > total) return `0 of ${total.toLocaleString()}`;
  return `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`;
}

/** The em dash used for "no value". Never render an empty cell. */
export const ADMIN_DASH = "—";

/* -------------------------------------------------------------------- labels */

/**
 * Sentence-case a stored status value so one vocabulary reaches the screen.
 *
 * Statuses arrive from the database in whatever case they were written (`ready`,
 * `completed`, `charged`, `ok`) while hand-written pills say `Active` / `Archived`.
 * `StatusPill` runs plain-string children through this, so pages never need a
 * `className="capitalize"` override and every chip reads the same way.
 */
export function statusLabel(value: string | null | undefined): string {
  const s = String(value ?? "").trim();
  if (!s) return "";
  if (s[0] !== s[0].toLowerCase()) return s; // already capitalised — leave it alone
  return s[0].toUpperCase() + s.slice(1);
}

/* ------------------------------------------------------------------ sections */

/**
 * Some admin pages carry more than one table (credits, emails). They still open with one
 * `AdminPageHeader`; everything below it is a *section*, and a section is a heading, one
 * line of prose, its own filter band and its table — the page shape, one level down.
 */

/** A section heading inside a page that holds more than one table. */
export const ADMIN_SECTION_TITLE = "text-[15px] font-semibold leading-6 tracking-tight text-[var(--fg)]";

/** The one-line description under a section heading. */
export const ADMIN_SECTION_DESC = "mt-0.5 text-[13px] leading-5 text-[var(--muted-2)]";

/** Space above a section heading, so sections read as separate things. */
export const ADMIN_SECTION_GAP = "mt-8";

/** A quiet footnote under a table or panel: caveats, not content. */
export const ADMIN_NOTE = "mt-2 text-[12px] leading-5 text-[var(--muted-2)]";

/**
 * A reference strip: rules, definitions, a caveat that belongs on the page rather than
 * under one table. Body copy must never float directly on `--bg` between two panels.
 */
export const ADMIN_NOTE_PANEL =
  "rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2.5 text-[12px] leading-5 text-[var(--muted-2)]";

/**
 * Controls that belong to ONE table inside a multi-table page (a sub-sort, a sub-pager).
 * Deliberately lighter than `AdminFilterBar`: no border, no panel, so the page keeps a
 * single full-width band and a reader can tell page scope from table scope.
 */
export const ADMIN_SUBBAR = "flex flex-wrap items-center gap-x-2 gap-y-2";

/* -------------------------------------------------------------------- panels */

/** Body copy inside a panel — the panel equivalent of a `--muted` table cell. */
export const ADMIN_PANEL_TEXT = "text-[13px] leading-5 text-[var(--muted)]";

/** The label above a field or a figure. Same metrics as a table header. */
export const ADMIN_FIELD_LABEL = ADMIN_HEAD_TEXT + " text-[var(--muted-2)]";

/** The value beside an `ADMIN_FIELD_LABEL`. */
export const ADMIN_FIELD_VALUE = "text-[13px] leading-5 text-[var(--fg)]";

/** One figure in a row of figures: label above, number below. */
export const ADMIN_STAT_TILE = "min-w-0 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3.5 py-2.5";

/** The number inside an `ADMIN_STAT_TILE`. */
export const ADMIN_STAT_VALUE = "mt-1 text-[19px] font-semibold leading-7 tabular-nums text-[var(--fg)]";

/** A link tile on the admin home page. */
export const ADMIN_TILE =
  "block rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3.5 py-3 transition hover:bg-[var(--panel-hover)] " +
  ADMIN_FOCUS_RING;

/* -------------------------------------------------------------- monospace box */

/** A prompt, an email body, a JSON blob: readable, scrollable, never the whole page. */
export const ADMIN_CODE_BLOCK =
  "overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 font-mono text-[12px] leading-5 text-[var(--fg)]";

/* --------------------------------------------------------------- row actions */

/**
 * A link that sits in a `RowActions` group beside `RowAction` buttons.
 *
 * `RowAction` is a `<button>`; a row action that navigates has to be an anchor so it can be
 * opened in a new tab, but it must be the same 26px control. Same metrics, same states.
 */
export const ADMIN_ROW_ACTION_LINK =
  "inline-flex h-[26px] items-center justify-center whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 text-[12px] font-medium leading-4 text-[var(--muted)] transition hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] " +
  ADMIN_FOCUS_RING;
