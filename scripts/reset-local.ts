/**
 * Empty the local database.
 *
 *   npm run reset
 *   npm run reset -- --dry
 *
 * Drops every collection in the database `MONGODB_URI` points at, and refuses to run unless that
 * database is on this machine. The guard is the point of the command: `MONGODB_URI` is one line in
 * one file and it is the same variable name in every environment, so the thing standing between a
 * test reset and a very bad afternoon should be a check, not care at the keyboard. See
 * `src/lib/db/localTarget.ts` for what counts as local — `mongodb+srv://` never does, and in a
 * replica-set URI *every* host has to be local, not just the first.
 *
 * It also stops the dev server from undoing the work. A running Next with a browser tab open
 * re-creates the signed-in user and their personal org within seconds of the drop, from the session
 * cookie, because any authenticated request calls `ensurePersonalOrgForUserId`. Worse, dropping a
 * collection drops its indexes, and Mongoose only rebuilds them when a model is next initialised —
 * in that window the unique index behind "one personal org per user" is not there, and two
 * concurrent requests produce two. This command checks the port and tells you before, rather than
 * leaving you to wonder why a wiped database has four collections in it.
 */
import "dotenv/config";
import net from "node:net";
import mongoose from "mongoose";

import { isLocalMongoTarget } from "@/lib/db/localTarget";

const DEV_PORT = 3001;

/** Is something listening on the dev port? */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(400);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}

async function main() {
  const dry = process.argv.slice(2).includes("--dry");
  const uri = (process.env.MONGODB_URI ?? "").trim();

  const verdict = isLocalMongoTarget(uri);
  if (!verdict.local) {
    console.error("\n  Refusing to reset.");
    console.error(`  ${verdict.reason}`);
    console.error("\n  This command only ever empties a database on this machine.\n");
    process.exit(1);
  }

  const dbName = (process.env.MONGODB_DB_NAME ?? "").trim() || (uri.split("/").pop() ?? "").split("?")[0] || "(default)";

  console.log("");
  console.log(`  target     ${verdict.hosts.join(", ")} / ${dbName}`);

  // Only for a run that actually drops something. `--dry` writes nothing, so refusing it here just
  // denies you the one command that answers "what is in there right now" without stopping the
  // server first — which is exactly when you want to ask.
  if (!dry && (await portInUse(DEV_PORT))) {
    console.log("");
    console.log(`  The dev server is running on :${DEV_PORT}.`);
    console.log("  A browser tab open on it will re-create your user and workspace seconds after the");
    console.log("  drop, and the indexes that went with the collections will not be back yet.");
    console.log("  Stop it first, reset, then start it again.");
    console.log("");
    process.exit(1);
  }

  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB_NAME || undefined });
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle after connecting.");

  const collections = await db.listCollections().toArray();
  const names = collections.map((c) => c.name).sort();

  // Documents, not collections. Starting the dev server re-creates every collection empty, because
  // Mongoose builds each model's indexes on first use — so a database that was reset thirty seconds
  // ago still lists two dozen of them. Reporting that count made a clean reset look like a failed
  // one. What somebody actually wants to know is whether there is anything *in* there.
  const counts = await Promise.all(
    names.map(async (name) => ({ name, n: await db.collection(name).countDocuments().catch(() => 0) })),
  );
  const occupied = counts.filter((c) => c.n > 0);
  const documents = counts.reduce((sum, c) => sum + c.n, 0);

  if (!documents) {
    console.log(`  Already empty (${names.length} empty collections, which the dev server re-creates).\n`);
    await mongoose.disconnect();
    return;
  }

  if (dry) {
    console.log(`  would drop ${documents} documents in ${names.length} collections`);
    console.log(`             ${occupied.map((c) => `${c.name}=${c.n}`).join(", ")}\n`);
    await mongoose.disconnect();
    return;
  }

  for (const name of names) await db.dropCollection(name).catch(() => void 0);

  // Ask again rather than trusting the loop: a drop that silently failed should not be reported as
  // a reset, and this is the command people run precisely when they want to be sure.
  const left = (await db.listCollections().toArray()).map((c) => c.name);
  await mongoose.disconnect();

  console.log(`  dropped    ${documents} documents in ${names.length} collections`);
  if (left.length) {
    console.log(`  remaining  ${left.length}: ${left.join(", ")}`);
    console.log("\n  Not everything went. Something is still connected and writing.\n");
    process.exit(1);
  }
  console.log("  remaining  0");
  console.log("\n  Empty. Start the dev server and sign in to begin again.\n");
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    await mongoose.disconnect().catch(() => void 0);
    console.error("\n  Failed:", e instanceof Error ? e.message : e, "\n");
    process.exit(1);
  });
