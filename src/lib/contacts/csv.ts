/**
 * The contacts CSV, as text.
 *
 * Kept apart from the service so the quoting can be tested without a database and so the route
 * that streams it has nothing to format. RFC 4180: a field is quoted when it carries a comma, a
 * quote, or a line break, and a quote inside a quoted field is doubled. Everything in a row is
 * reader-supplied at some point (a name, an address), so every field goes through the same rule
 * rather than the ones somebody thought were safe.
 *
 * Identity follows the plan here exactly as on the page: a redacted row arrives with `name` and
 * `email` already null (the service applies decision 4 before this sees it) and prints as empty
 * cells, never as "Someone", because a spreadsheet cell that says "Someone" is a value someone
 * will sort on.
 */
import type { ContactRow } from "./service";

/** The column order, which is also the header line. */
export const CONTACTS_CSV_COLUMNS = [
  "name",
  "email",
  "domain",
  "verified",
  "first_seen",
  "last_seen",
  "documents_read",
  "projects",
  "visits",
  "tags",
  "last_source",
] as const;

/** One field, quoted only when RFC 4180 says it has to be. */
export function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (!/[",\r\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** One contact as the cells of a row, in `CONTACTS_CSV_COLUMNS` order. */
export function contactCsvCells(row: ContactRow): string[] {
  return [
    row.name ?? "",
    row.email ?? "",
    row.domain ?? "",
    row.verified ? "true" : "false",
    row.firstSeenAt,
    row.lastSeenAt,
    String(row.documentsRead),
    String(row.projectsCount),
    String(row.visits),
    row.tags.map((t) => t.name).join(", "),
    row.lastSource?.kind ?? "",
  ];
}

/** The whole file: header, then one line per row, CRLF-terminated as the RFC prefers. */
export function contactsToCsv(rows: ReadonlyArray<ContactRow>): string {
  const lines = [CONTACTS_CSV_COLUMNS.join(",")];
  for (const row of rows) lines.push(contactCsvCells(row).map(csvField).join(","));
  return lines.join("\r\n") + "\r\n";
}
