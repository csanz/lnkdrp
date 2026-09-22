/**
 * Make one account an admin, or take it back.
 *
 *   npm run admin:add -- --to=someone@example.com
 *   npm run admin:add -- --to=someone@example.com --remove
 *   npm run admin:list
 *
 * An admin can read every workspace's data through `/a`, approve people, and change plans. There is
 * no invitation and no email: this is not something somebody accepts, it is something you do to an
 * account that already exists, and a mail announcing it would only be a phishing template with our
 * name on it.
 *
 * Approving off the waitlist comes with it, because an admin who cannot sign in is not an admin.
 *
 * The last admin cannot be removed. Emptying the role locks `/a` for everybody — `requireAdmin`
 * refuses every caller and there is no route back in except a script like this one, which is a bad
 * afternoon to hand somebody.
 */
import "dotenv/config";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { approveUser } from "@/lib/waitlist/waitlist";

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
      "  Usage: npm run admin:add -- --to=someone@example.com",
      "",
      "    --to=<email>   the account (required)",
      "    --remove       take the role away instead of granting it",
      "    --list         print the current admins and exit",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * Admins who can actually sign in.
 *
 * `{ role: "admin" }` alone counts rows that cannot: `actor.ts` ends the session of anybody with
 * `isActive === false` or a `deletionRequestedAt`, and the purge leaves the tombstone's `role`
 * untouched. So a deleted admin still answered the last-admin guard, and removing the only working
 * one passed the check and closed `/a` to everybody — the exact lockout this script's docstring
 * says cannot happen.
 */
async function listAdmins(): Promise<Array<{ email: string; id: string }>> {
  const rows = (await UserModel.find({
    role: "admin",
    isActive: { $ne: false },
    deletionRequestedAt: null,
  })
    .select({ email: 1 })
    .lean()) as Array<{ _id: Types.ObjectId; email?: string | null }>;
  return rows.map((r) => ({ email: (r.email ?? "").trim() || "(no email)", id: String(r._id) }));
}

/**
 * Refuse to act on an account that cannot sign in.
 *
 * A person keeps their real address through the 30-day deletion grace period while every request
 * from them is already refused. Inviting them mails "your account is open" to somebody who asked
 * to be forgotten, with a link that can never work; granting them a role adds an admin who cannot
 * use it — and inflates the count the guard above depends on.
 */
export function refuseIfUnusable(row: { isActive?: unknown; deletionRequestedAt?: unknown }, email: string): void {
  if (row.isActive === false || row.deletionRequestedAt) {
    console.error(`\n  ${email} has requested deletion or is disabled.`);
    console.error("  Every request from that account is already refused, so this would do nothing but send mail.\n");
    process.exit(1);
  }
}

async function main() {
  const a = args(process.argv.slice(2));
  await connectMongo();

  if (a.list === true) {
    const admins = await listAdmins();
    console.log("");
    if (!admins.length) console.log("  No admins.");
    for (const x of admins) console.log(`  ${x.email}  (${x.id})`);
    console.log("");
    return;
  }

  const to = typeof a.to === "string" ? a.to.trim().toLowerCase() : "";
  if (!to) usage("--to is required.");
  if (!to.includes("@")) usage(`"${to}" is not an email address.`);
  const remove = a.remove === true;

  const user = (await UserModel.findOne({ email: new RegExp(`^${to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") })
    .select({ _id: 1, email: 1, role: 1, accessStatus: 1, isActive: 1, deletionRequestedAt: 1 })
    .lean()) as {
    _id: Types.ObjectId;
    email?: string | null;
    role?: string | null;
    accessStatus?: string | null;
    isActive?: unknown;
    deletionRequestedAt?: unknown;
  } | null;

  if (!user) {
    console.error(`\n  No account for ${to}.`);
    console.error("  They have to sign in once before the role can be given — that is what creates the account.\n");
    process.exit(1);
  }

  refuseIfUnusable(user, user.email ?? to);

  const userId = String(user._id);
  const isAdmin = user.role === "admin";

  if (remove) {
    if (!isAdmin) {
      console.log(`\n  ${user.email ?? to} is not an admin. Nothing to do.\n`);
      return;
    }
    const admins = await listAdmins();
    if (admins.length <= 1) {
      console.error("\n  That is the only admin. Removing it locks everyone out of /a.");
      console.error("  Grant the role to somebody else first.\n");
      process.exit(1);
    }
    await UserModel.updateOne({ _id: user._id }, { $set: { role: "user" } });
    console.log(`\n  ${user.email ?? to} is no longer an admin.\n`);
    return;
  }

  if (isAdmin) {
    console.log(`\n  ${user.email ?? to} is already an admin.`);
  } else {
    await UserModel.updateOne({ _id: user._id }, { $set: { role: "admin" } });
    console.log(`\n  ${user.email ?? to} is now an admin.`);
  }

  // An admin who is still queued cannot sign in to use the role.
  const approval = await approveUser({ userId });
  if (approval.ok && approval.changed) console.log("  Also approved off the waitlist.");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n  Failed:", e instanceof Error ? e.message : e, "\n");
    process.exit(1);
  });
