/**
 * Send every email template to one address, so a person can see how they actually render.
 *
 * Previews (`/a/emails`) show the body a builder produced. They cannot show what Gmail does to it,
 * whether the dark-mode ground bleeds through, how the subject truncates on a phone, or whether an
 * unsubscribe header survives the trip. Only a real message answers those, and the only honest way
 * to check is to send one.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/send-test-emails.ts --list
 *   npx tsx --env-file=.env.local scripts/send-test-emails.ts --to=you@example.com
 *   ... --to=you@example.com --only=share_views.immediate,plan_limit
 *   ... --to=you@example.com --dry-run
 *
 * Safety, in the order it matters:
 *
 *   - **`--to` is required and is the only recipient.** Nothing is read from the database, so there
 *     is no path by which a real customer receives one of these.
 *   - **Every subject is prefixed `[TEST]`**, so a message that escapes into a shared inbox is
 *     obviously not a live notification.
 *   - **`EMAIL_TRANSPORT=console` short-circuits the whole thing** — that is the setting this repo
 *     runs with by default precisely so scripts do not send, and a script whose job is to send has
 *     to say plainly that it did nothing rather than appear to succeed.
 *   - It paces the sends, because Resend rate-limits and a burst that gets throttled halfway looks
 *     exactly like a template that failed to build.
 */
import { buildPreviews, type PreviewRow } from "@/lib/email/previews";
import { EMAIL_CATALOG } from "@/lib/email/templates";

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
};

/** Resend's own limit is per second; this stays comfortably under it. */
const GAP_MS = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function listTemplates(rows: PreviewRow[]) {
  const covered = new Set(rows.map((r) => r.catalogId));
  console.log(`\n${rows.length} renderable template${rows.length === 1 ? "" : "s"}:\n`);
  for (const r of rows) {
    console.log(`  ${r.catalogId.padEnd(28)} ${r.label}`);
    console.log(`  ${"".padEnd(28)} ${r.subject}`);
  }
  const missing = EMAIL_CATALOG.filter((c) => !covered.has(c.id));
  if (missing.length) {
    console.log(`\n${missing.length} in the catalogue with no pure builder, so not sendable from here:`);
    for (const m of missing) console.log(`  ${m.id.padEnd(28)} ${m.what} (${m.builtBy})`);
  }
}

async function main() {
  const rows = buildPreviews();

  if (flag("list") !== null) return listTemplates(rows);

  const to = (flag("to") ?? "").trim();
  if (!to || !to.includes("@")) {
    console.error("Missing --to=<address>. Nothing is sent without an explicit recipient.");
    console.error("Run with --list to see what would be sent.");
    process.exit(2);
  }

  const only = (flag("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const chosen = only.length ? rows.filter((r) => only.includes(r.catalogId) || only.includes(r.key)) : rows;
  if (!chosen.length) {
    console.error(`No template matched --only=${only.join(",")}. Run with --list.`);
    process.exit(2);
  }

  const dryRun = flag("dry-run") !== null;
  // Printing is a legitimate way to read the copy, so this does not refuse — but it says so in a
  // way that cannot be mistaken for a send, and the summary at the end repeats it. A script whose
  // whole job is sending must never let "printed 17 emails" read as "delivered 17 emails".
  const transport = (process.env.EMAIL_TRANSPORT ?? "").trim().toLowerCase();
  const consoleOnly = transport === "console";
  if (consoleOnly && !dryRun) {
    console.log("EMAIL_TRANSPORT=console — bodies are printed below, NOT delivered.");
    console.log("Unset EMAIL_TRANSPORT for a real send.\n");
  }

  console.log(`\n${dryRun ? "Would send" : "Sending"} ${chosen.length} template(s) to ${to}\n`);

  // Imported here, not at module scope: `--list` and `--dry-run` must work without a Resend key.
  const { sendTextEmail } = await import("@/lib/email/sendTextEmail");

  let sent = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const row of chosen) {
    const subject = `[TEST] ${row.subject}`;
    if (dryRun) {
      console.log(`  would send  ${row.catalogId.padEnd(28)} ${subject}`);
      sent += 1;
      continue;
    }
    try {
      await sendTextEmail({
        to,
        subject,
        text: row.text,
        ...(row.html ? { html: row.html } : {}),
        // The real headers, so one-click unsubscribe can be checked in a client that honours it.
        ...(row.headers?.length
          ? { headers: Object.fromEntries(row.headers.map((h) => [h.name, h.value])) }
          : {}),
      });
      console.log(`  ${consoleOnly ? "printed " : "sent    "}    ${row.catalogId.padEnd(28)} ${subject}`);
      sent += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  FAILED      ${row.catalogId.padEnd(28)} ${msg.slice(0, 80)}`);
      failures.push({ id: row.catalogId, error: msg });
    }
    await sleep(GAP_MS);
  }

  const verb = dryRun ? "would be sent" : consoleOnly ? "printed, NOT delivered" : "sent";
  console.log(`\n${sent} ${verb}, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

void main();
