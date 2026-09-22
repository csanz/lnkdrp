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
 *   ... --to=you@example.com --all          # every variant, not one per template
 *   ... --to=you@example.com --only=share_views.immediate,plan_limit
 *   ... --to=you@example.com --raw        # exact subjects, no [TEST] prefix
 *   ... --to=you@example.com --print      # print the bodies instead of sending
 *   ... --to=you@example.com --dry-run
 *
 * Safety, in the order it matters:
 *
 *   - **`--to` is required and is the only recipient.** Nothing is read from the database, so there
 *     is no path by which a real customer receives one of these.
 *   - **Every subject is prefixed `[TEST]`**, so a message that escapes into a shared inbox is
 *     obviously not a live notification. `--raw` drops the prefix, for when the question is what a
 *     recipient actually sees — a subject you cannot read as sent is a subject you cannot judge.
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
  const byId = new Map<string, PreviewRow[]>();
  for (const r of rows) byId.set(r.catalogId, [...(byId.get(r.catalogId) ?? []), r]);

  console.log(`\n${byId.size} template${byId.size === 1 ? "" : "s"}, ${rows.length} fixtures.`);
  console.log(`A plain run sends the first of each; --all sends every one.\n`);
  for (const [id, group] of byId) {
    console.log(`  ${id}`);
    group.forEach((r, i) => {
      // The marker says which one a plain run would actually send.
      console.log(`    ${i === 0 ? "*" : " "} ${r.key.padEnd(38)} ${r.label}`);
      console.log(`      ${"".padEnd(38)} ${r.subject}`);
    });
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
  const matched = only.length ? rows.filter((r) => only.includes(r.catalogId) || only.includes(r.key)) : rows;
  if (!matched.length) {
    console.error(`No template matched --only=${only.join(",")}. Run with --list.`);
    process.exit(2);
  }

  /**
   * One email per template, unless you ask for more.
   *
   * Several templates carry more than one fixture, because the same builder produces materially
   * different mail depending on what it is given — a welcome with a name and one without, a
   * plan-limit warning at three stages. Those exist so the previews page can show the cases, and
   * sending all of them means the inbox gets two near-identical welcomes and you have to work out
   * which is which. Reviewing the copy is the normal reason to run this, and for that one per
   * template is the whole point; `--all` is there for the day you want to compare the variants.
   */
  const variants = flag("all") !== null;
  const seen = new Set<string>();
  const chosen = variants
    ? matched
    : matched.filter((r) => {
        if (seen.has(r.catalogId)) return false;
        seen.add(r.catalogId);
        return true;
      });
  const hidden = matched.length - chosen.length;

  const dryRun = flag("dry-run") !== null;
  // Off by default: the prefix is what stops a stray test looking like a live notification, so
  // dropping it has to be something you asked for.
  const raw = flag("raw") !== null;
  /**
   * `.env.local` sets `EMAIL_TRANSPORT=console` so the dev server cannot mail anyone by accident.
   * This script is the deliberate exception: it has an explicit `--to` and exists to send. Passing
   * `--print` keeps the console transport when you only want to read the copy.
   *
   * Printing does not refuse, but it says so in a way that cannot be mistaken for a send, and the
   * summary repeats it — a script whose whole job is sending must never let "printed 17 emails"
   * read as "delivered 17 emails".
   */
  const consoleOnly = flag("print") !== null;
  if (!consoleOnly) delete process.env.EMAIL_TRANSPORT;
  if (consoleOnly && !dryRun) {
    process.env.EMAIL_TRANSPORT = "console";
    console.log("--print — bodies are printed below, NOT delivered.\n");
  }

  console.log(`\n${dryRun ? "Would send" : "Sending"} ${chosen.length} email${chosen.length === 1 ? "" : "s"} to ${to}`);
  /**
   * Say what was left out, but do not make it look like a failure.
   *
   * The first version printed "7 extra variant(s) skipped" on its own line directly under the
   * count, which reads as a warning about something that went wrong — especially on a run that
   * asked for one template and was told a variant had been skipped. It is neither a warning nor
   * an error: it is the normal, chosen behaviour. Parenthesised and lower-case, it reads as the
   * footnote it is, and still never lets a partial run pass for a complete one.
   */
  if (hidden > 0) {
    const one = hidden === 1;
    console.log(`(${hidden} more variant${one ? "" : "s"} ${one ? "exists" : "exist"} — pass --all to send ${one ? "it" : "them"} too.)`);
  }
  console.log("");

  // Imported here, not at module scope: `--list` and `--dry-run` must work without a Resend key.
  const { sendTextEmail } = await import("@/lib/email/sendTextEmail");

  let sent = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const row of chosen) {
    const subject = raw ? row.subject : `[TEST] ${row.subject}`;
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
