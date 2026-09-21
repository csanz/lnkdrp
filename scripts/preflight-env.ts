/**
 * `npx tsx --env-file=prod.env scripts/preflight-env.ts` — check a set of values before you paste
 * them anywhere. The same checks the admin page `/a/env` runs; see `src/lib/preflight/env.ts` for
 * what each one proves and why presence alone proves nothing.
 *
 * Exits non-zero on any failure, so it works as a release gate.
 */
import { runEnvPreflight, summarise, type Status } from "@/lib/preflight/env";

const ICON: Record<Status, string> = { ok: "  ok  ", warn: " warn ", fail: " FAIL ", skip: " skip " };

async function main() {
  const results = await runEnvPreflight({ offline: process.argv.includes("--offline") });
  const width = Math.max(10, ...results.map((r) => r.name.length));
  let group = "";
  console.log("");
  for (const r of results) {
    if (r.group !== group) {
      group = r.group;
    }
    console.log(`[${ICON[r.status]}] ${r.group.padEnd(9)} ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const s = summarise(results);
  console.log(`\n${s.fail} failing, ${s.warn} warning, ${s.ok} ok, ${s.skip} skipped.`);
  if (s.fail) console.log("A failing row means this deployment will not work. See DEPLOY.md section 5.");
  process.exit(s.fail ? 1 : 0);
}

void main();
