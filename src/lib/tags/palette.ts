/**
 * The tag palette.
 *
 * Colour is assigned automatically so tagging costs one keystroke, and changeable per tag so
 * "green is fundraising" can be made durable by anyone who cares (docs/prds/lnkdrp-tags.md).
 *
 * Client-safe: no database imports, so the sidebar dot, the chip and the picker all read the same
 * list as the service that assigns it. Colours are stored by key, never as hex, so a shade can be
 * retuned here without a data migration.
 *
 * Chosen to stay apart at 6px — the size of a sidebar dot — and to avoid the two meanings this
 * product already spends colour on: amber is starred, and emerald alone reads as the live/positive
 * tone used by charts and status pills, so the green here is a cooler jade.
 *
 * Twelve rather than the original six. Six is enough to tell four tags apart and nothing at all
 * once a workspace files properly: at two hundred tags it is thirty-three to a colour, and a colour
 * thirty-three things share has stopped saying anything. Twelve is the most that still reads as
 * distinct hues at dot size rather than as shades of each other — past that the picker is choosing
 * between two blues, which is worse than having fewer.
 *
 * Order matters: `nextTagColor` walks this list, so the first six are the originals and an existing
 * workspace keeps assigning what it always did until it runs out.
 */
export const TAG_COLOR_KEYS = [
  "jade",
  "sky",
  "amber",
  "rose",
  "violet",
  "slate",
  "teal",
  "indigo",
  "fuchsia",
  "orange",
  "lime",
  "red",
] as const;

export type TagColorKey = (typeof TAG_COLOR_KEYS)[number];

/** The default when a stored key is unknown (a palette entry retired after rows referenced it). */
export const DEFAULT_TAG_COLOR: TagColorKey = "slate";

/**
 * Hex per key, one pair each so a dot holds up on both grounds: the sidebar is dark by default but
 * the app has a light theme, and a colour tuned only for one looks muddy in the other.
 */
export const TAG_COLORS: Record<TagColorKey, { dark: string; light: string; label: string }> = {
  jade: { dark: "#34d399", light: "#0c7a55", label: "Jade" },
  sky: { dark: "#60a5fa", light: "#2563eb", label: "Sky" },
  amber: { dark: "#f59e0b", light: "#b45309", label: "Amber" },
  rose: { dark: "#f472b6", light: "#be185d", label: "Rose" },
  violet: { dark: "#a78bfa", light: "#6d28d9", label: "Violet" },
  slate: { dark: "#94a3b8", light: "#475569", label: "Slate" },
  teal: { dark: "#2dd4bf", light: "#0f766e", label: "Teal" },
  indigo: { dark: "#818cf8", light: "#4338ca", label: "Indigo" },
  fuchsia: { dark: "#e879f9", light: "#a21caf", label: "Fuchsia" },
  orange: { dark: "#fb923c", light: "#c2410c", label: "Orange" },
  lime: { dark: "#a3e635", light: "#4d7c0f", label: "Lime" },
  red: { dark: "#f87171", light: "#b91c1c", label: "Red" },
};

/** Narrow an unknown stored value to a palette key. */
export function asTagColorKey(value: unknown): TagColorKey {
  return typeof value === "string" && (TAG_COLOR_KEYS as readonly string[]).includes(value)
    ? (value as TagColorKey)
    : DEFAULT_TAG_COLOR;
}

/**
 * The colour a new tag gets: the least-used one in the workspace, ties broken by palette order.
 *
 * Round-robin rather than random, so the first five tags in a workspace are five different colours
 * — the case where a colour is most useful and a collision most annoying.
 */
export function nextTagColor(usedCounts: Readonly<Partial<Record<TagColorKey, number>>>): TagColorKey {
  let best: TagColorKey = TAG_COLOR_KEYS[0];
  let bestCount = Number.POSITIVE_INFINITY;
  for (const key of TAG_COLOR_KEYS) {
    const count = Math.max(0, usedCounts[key] ?? 0);
    if (count < bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}
