#!/usr/bin/env node
/**
 * Best-effort backfill for Review.intel from Review.outputMarkdown.
 *
 * This does NOT attempt to fully reconstruct structured intel; it primarily extracts:
 * - Company Name / Company URL
 * - Contact Name / Contact Email / Contact URL
 * - Effectiveness score (when present as "Score: X / 10")
 *
 * Usage:
 *   node scripts/review-intel-backfill.mjs           # dry-run (prints summary only)
 *   node scripts/review-intel-backfill.mjs --apply  # writes updates
 *
 * Env (loaded automatically from .env.local):
 *   - MONGODB_URI (required)
 *   - MONGODB_DB_NAME (optional; uses default from URI if omitted)
 */
import process from "node:process";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config({ path: ".env.local" });

/**
 * Print usage instructions for review-intel-backfill.mjs and exit.
 */

function usage(exitCode = 1) {
  const msg = `
Usage:
  node scripts/review-intel-backfill.mjs
  node scripts/review-intel-backfill.mjs --apply
`;
  console.error(msg.trim());
  process.exit(exitCode);
}

/**
 * As Line Value.
 */

function asLineValue(md, label) {
  const rx = new RegExp(`^\\s*(?:[-*•]\\s*)?${label}\\s*[:\\-]\\s*(.+)\\s*$`, "im");
  const m = rx.exec(md || "");
  if (!m || !m[1]) return null;
  const v = String(m[1]).trim();
  if (!v) return null;
  return v;
}

/**
 * Extract Score.
 */

function extractScore(md) {
  const m = /Score:\s*([0-9]{1,2})\s*\/\s*10/i.exec(md || "");
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 10) return null;
  return n;
}

/**
 * Run review-intel-backfill.mjs: Best-effort backfill for Review.intel from Review.outputMarkdown.
 */

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) usage(0);
  const apply = args.has("--apply");

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error(
      [
        "Missing MONGODB_URI.",
        "Add it to .env.local (this script loads .env.local automatically).",
      ].join("\n"),
    );
    process.exit(1);
  }
  const dbName = process.env.MONGODB_DB_NAME;

  await mongoose.connect(uri, {
    dbName,
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
  });

  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error("No db handle after connecting.");
    const reviewsCol = db.collection("reviews");

    const filter = {
      outputMarkdown: { $type: "string", $ne: "" },
      $or: [{ intel: { $exists: false } }, { intel: null }],
    };

    const total = await reviewsCol.countDocuments({});
    const missing = await reviewsCol.countDocuments(filter);

    console.log(
      [
        `Connected${dbName ? ` (dbName=${dbName})` : ""}.`,
        `Reviews: ${total}`,
        `Reviews missing intel: ${missing}`,
        apply ? "Mode: APPLY (writing changes)" : "Mode: DRY-RUN (no writes)",
      ].join("\n"),
    );

    if (!missing) return;
    if (!apply) return;

    const cursor = reviewsCol.find(filter, { projection: { _id: 1, outputMarkdown: 1 } });
    let updated = 0;
    while (await cursor.hasNext()) {
      const r = await cursor.next();
      const md = (r && typeof r.outputMarkdown === "string") ? r.outputMarkdown : "";
      if (!md) continue;

      const intel = {
        company: {
          name: asLineValue(md, "Company Name"),
          url: asLineValue(md, "Company URL"),
        },
        contact: {
          name: asLineValue(md, "Contact Name"),
          email: asLineValue(md, "Contact Email"),
          url: asLineValue(md, "Contact URL"),
        },
        overallAssessment: asLineValue(md, "Overall Assessment"),
        effectivenessScore: extractScore(md),
        scoreRationale: asLineValue(md, "Rationale"),
        strengths: [],
        weaknessesAndRisks: [],
        recommendations: [],
        actionItems: [],
        suggestedRewrites: null,
      };

      const res = await reviewsCol.updateOne({ _id: r._id }, { $set: { intel } });
      if (res.modifiedCount) updated += 1;
    }

    console.log(`Done. Updated reviews: ${updated}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});




