/**
 * The name a first workspace arrives with until its owner names it at `/welcome`.
 *
 * Not a kind, only a placeholder: a workspace is whatever its owner calls it. Its own module,
 * with no model import, so the share page and the name helpers can read it without pulling
 * Mongoose in (and so tests that mock the Org model do not lose it).
 */
export const DEFAULT_WORKSPACE_NAME = "Personal";

/** Whether `name` is still the placeholder, or nothing at all. */
export function isPlaceholderWorkspaceName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  return !n || n.toLowerCase() === DEFAULT_WORKSPACE_NAME.toLowerCase();
}
