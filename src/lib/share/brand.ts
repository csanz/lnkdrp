/**
 * The sender's identity as the *browser* needs it — a name and an icon url, nothing else.
 *
 * Split from `shareBrand.ts` for one hard reason: that module reaches Mongo to resolve the
 * workspace, and this shape is rendered by `BrandHeader`, which the PDF viewer and the password
 * gate both pull into the client bundle. A single value import across that line drags mongoose into
 * the browser, where it fails at module evaluation and takes every page down with it — which is
 * exactly what happened when these lived together. Types erase; `brandInitials` does not.
 *
 * Keep this file free of imports.
 */
export type ShareWorkspaceBrand = {
  /** What the recipient sees: the team's name, or the person's. */
  name: string;
  /** The workspace's uploaded icon — a white logo on the black tile `WorkspaceIcon` draws. */
  avatarUrl: string | null;
};

/** Initials for the fallback tile: "USAVX Holdings" → "UH", "Christian" → "C". */
export function brandInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const first = words[0]?.[0] ?? "";
  const second = words.length > 1 ? words[words.length - 1]?.[0] ?? "" : "";
  return `${first}${second}`.toUpperCase();
}
