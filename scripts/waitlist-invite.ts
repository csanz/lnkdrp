/**
 * Let one person off the waitlist and send them their invitation.
 *
 *   npm run waitlist:invite -- --to=someone@example.com
 *   npm run waitlist:invite -- --to=someone@example.com --dry
 *   npm run waitlist:invite -- --to=someone@example.com --ttl-days=30
 *
 * What happens, in this order:
 *
 *   1. The account is approved (`approveUser`), so they are out of the queue.
 *   2. A signed `/accept` token is minted for that user id.
 *   3. The invitation email goes out carrying the link.
 *
 * Approval first, on purpose. The email is the part that can fail — a provider being down, a
 * bounced address — and an account that is open but whose invitation did not arrive is a person you
 * can re-send to. An account still queued because the mail failed is a person stuck behind a
 * sign-up form with nothing to tell them why.
 *
 * **This sends real mail.** `.env.local` carries a live `RESEND_API_KEY` and no `EMAIL_TRANSPORT`,
 * so anything you type here lands in somebody's inbox. `EMAIL_TRANSPORT=console` prints it instead,
 * and `--dry` stops before both the write and the send, printing the link it would have mailed.
 */
import "dotenv/config";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { approveUser } from "@/lib/waitlist/waitlist";
import { createAcceptToken, WAITLIST_ACCEPT_TTL_MS } from "@/lib/waitlist/acceptToken";
import { sendWaitlistApprovedEmail } from "@/lib/email/sendWaitlistApprovedEmail";
import { getPublicSiteBase } from "@/lib/urls";

/** `--key=value` and bare `--flag`, which is all these scripts ever need. */
function args(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const body = raw.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) out[body] = true;
    else out[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return out;
}

function usage(message?: string): never {
  if (message) console.error(`\n  ${message}\n`);
  console.error(
    [
      "  Usage: npm run waitlist:invite -- --to=someone@example.com",
      "",
      "    --to=<email>       who to let in (required)",
      "    --ttl-days=<n>     how long the accept link lives (default 14)",
      "    --base=<url>       site URL for the link (default NEXT_PUBLIC_SITE_URL)",
      "    --dry              print the link, write nothing, send nothing",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

async function main() {
  const a = args(process.argv.slice(2));
  const to = typeof a.to === "string" ? a.to.trim().toLowerCase() : "";
  if (!to) usage("--to is required.");
  if (!to.includes("@")) usage(`"${to}" is not an email address.`);

  const dry = a.dry === true;
  const ttlDays = typeof a["ttl-days"] === "string" ? Number(a["ttl-days"]) : NaN;
  const ttlMs = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 24 * 60 * 60 * 1000 : WAITLIST_ACCEPT_TTL_MS;

  const base = ((typeof a.base === "string" ? a.base : "") || getPublicSiteBase() || "http://localhost:3001")
    .trim()
    .replace(/\/+$/, "");

  await connectMongo();

  // Case-insensitively, because an address typed by hand rarely matches the case it was stored in.
  const user = (await UserModel.findOne({ email: new RegExp(`^${to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") })
    .select({ _id: 1, email: 1, name: 1, accessStatus: 1, termsAcceptedAt: 1 })
    .lean()) as {
    _id: Types.ObjectId;
    email?: string | null;
    name?: string | null;
    accessStatus?: string | null;
    termsAcceptedAt?: Date | null;
  } | null;

  if (!user) {
    console.error(`\n  No account for ${to}.`);
    console.error("  They have to sign in once before they can be invited — that is what creates the account.\n");
    process.exit(1);
  }

  const userId = String(user._id);
  const token = createAcceptToken({ userId, ttlMs });
  const acceptUrl = `${base}/accept?token=${encodeURIComponent(token)}`;

  console.log("");
  console.log(`  account    ${user.email ?? to}  (${userId})`);
  console.log(`  status     ${user.accessStatus ?? "approved"}`);
  console.log(`  terms      ${user.termsAcceptedAt ? `accepted ${new Date(user.termsAcceptedAt).toISOString()}` : "not accepted"}`);
  console.log(`  link       ${acceptUrl}`);
  console.log("");

  if (dry) {
    console.log("  --dry: nothing written, nothing sent.\n");
    return;
  }

  const approval = await approveUser({ userId });
  if (!approval.ok) {
    console.error("  Could not approve that account.\n");
    process.exit(1);
  }
  console.log(approval.changed ? "  approved   yes (was queued)" : "  approved   already was");

  const transport = (process.env.EMAIL_TRANSPORT ?? "").trim().toLowerCase();
  await sendWaitlistApprovedEmail({
    to: user.email ?? to,
    name: user.name ?? null,
    appUrl: base,
    acceptUrl,
  });
  console.log(transport === "console" ? "  emailed    printed above (EMAIL_TRANSPORT=console)" : `  emailed    sent to ${user.email ?? to}`);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n  Failed:", e instanceof Error ? e.message : e, "\n");
    process.exit(1);
  });
