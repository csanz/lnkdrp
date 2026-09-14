/**
 * Repair funding asks and fallback metrics stored before the raise-aware rules (2026-09-13).
 *
 * The old fallbacks stored the first dollar amount in a document as its ask (an operating cost such
 * as "$65 per flight hour" became "Ask: $65"), labelled every dollar figure "Funding ask: …" in key
 * metrics and "Raising …" in structure signals, and added invented milestones from words like
 * "fly". This re-applies `resolveAsk` / `findRaiseAmount` to stored `aiOutput` on docs and uploads.
 *
 * Usage:
 * - Dry run (default):  tsx --env-file=.env.local scripts/ai-ask-repair.ts
 * - Apply:              tsx --env-file=.env.local scripts/ai-ask-repair.ts --apply
 */
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { findRaiseAmount, resolveAsk } from "@/lib/ai/askFromText";

const INVENTED = new Set([
  "milestone: complete first prototype",
  "milestone: autonomous takeoff/stabilize/fly/land",
  "claim: edge-native autonomy without cloud dependency",
]);

type Ai = { ask?: unknown; key_metrics?: unknown; structure_signals?: unknown; document_purpose?: unknown };

function repair(ai: Ai, text: string): { changed: boolean; next: Record<string, unknown>; note: string } {
  const raise = findRaiseAmount(text);
  const oldAsk = typeof ai.ask === "string" ? ai.ask : "";
  const ask = resolveAsk(oldAsk, text, typeof ai.document_purpose === "string" ? ai.document_purpose : null);
  const keep = (list: unknown, prefix: string) =>
    (Array.isArray(list) ? list : []).filter((v): v is string => typeof v === "string").filter((v) => {
      if (INVENTED.has(v.toLowerCase())) return false;
      if (v.startsWith(prefix)) return Boolean(raise) && v === `${prefix}${raise}`;
      return true;
    });
  const metrics = keep(ai.key_metrics, "Funding ask: ");
  const signals = keep(ai.structure_signals, "Raising ");
  const changed =
    ask !== oldAsk ||
    JSON.stringify(metrics) !== JSON.stringify(ai.key_metrics ?? []) ||
    JSON.stringify(signals) !== JSON.stringify(ai.structure_signals ?? []);
  return {
    changed,
    next: { "aiOutput.ask": ask, "aiOutput.key_metrics": metrics, "aiOutput.structure_signals": signals },
    note: `ask ${JSON.stringify(oldAsk)} -> ${JSON.stringify(ask)}`,
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  await connectMongo();
  let uploadsFixed = 0;
  let docsFixed = 0;

  const uploads = (await UploadModel.find({ aiOutput: { $ne: null } })
    .select({ _id: 1, aiOutput: 1, rawExtractedText: 1, pdfText: 1 })
    .lean()) as Array<{ _id: unknown; aiOutput?: Ai; rawExtractedText?: string; pdfText?: string }>;
  const textByUpload = new Map<string, string>();
  for (const u of uploads) {
    const text = u.rawExtractedText ?? u.pdfText ?? "";
    textByUpload.set(String(u._id), text);
    if (!u.aiOutput) continue;
    const r = repair(u.aiOutput, text);
    if (!r.changed) continue;
    uploadsFixed += 1;
    console.log(`[ask-repair] upload ${String(u._id)} ${r.note}`);
    if (apply) await UploadModel.updateOne({ _id: u._id }, { $set: r.next });
  }

  const docs = (await DocModel.find({ aiOutput: { $ne: null } })
    .select({ _id: 1, title: 1, aiOutput: 1, currentUploadId: 1, extractedText: 1 })
    .lean()) as Array<{ _id: unknown; title?: string; aiOutput?: Ai; currentUploadId?: unknown; extractedText?: string }>;
  for (const d of docs) {
    if (!d.aiOutput) continue;
    const text = (d.currentUploadId ? textByUpload.get(String(d.currentUploadId)) : undefined) ?? d.extractedText ?? "";
    const r = repair(d.aiOutput, text);
    if (!r.changed) continue;
    docsFixed += 1;
    console.log(`[ask-repair] doc ${String(d._id)} "${d.title ?? ""}" ${r.note}`);
    if (apply) await DocModel.updateOne({ _id: d._id }, { $set: r.next });
  }
  console.log(`[ask-repair] uploads ${uploadsFixed}, docs ${docsFixed}; ${apply ? "applied" : "dry run (pass --apply)"}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
