/**
 * The realtime server's visit-brief accelerator has to agree with the engine about how long a
 * reader must be quiet before their visit is over (docs/prds/lnkdrp-visit-briefs.md, M4).
 *
 * `realtime/server.ts` is import-free by design (everything it pulls in must be COPYed into its
 * Dockerfile), so it carries its own copy of the window. If the engine's changes and this one does
 * not, the poke lands before the row is due and the cron finds nothing — and the five-minute tick
 * silently becomes the only path again. Read from source, like the viewer-gate test beside it.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));

const { VISIT_QUIET_MS } = await import("@/lib/visits/scheduleVisitBrief");

const source = fs.readFileSync(path.resolve(__dirname, "../../realtime/server.ts"), "utf8");

describe("the visit-brief accelerator", () => {
  test("waits the engine's quiet window, plus slack, before poking the cron", () => {
    const m = /const BRIEF_QUIET_MS = ([^;]+);/.exec(source);
    expect(m, "BRIEF_QUIET_MS is defined in realtime/server.ts").toBeTruthy();
     
    const value = Number(new Function(`return (${m![1]})`)());
    expect(value).toBe(VISIT_QUIET_MS);
    expect(/BRIEF_QUIET_MS \+ BRIEF_POKE_SLACK_MS/.test(source)).toBe(true);
  });

  test("pokes the cron route for one workspace, and touches on every progress write", () => {
    expect(source).toMatch(/\/api\/cron\/visit-briefs\?workspaceId=/);
    expect(source).toMatch(/briefPoker\.touch\(orgId,/);
    // The poke is a nudge to look, never the decision: the route claims only due rows.
    expect(source).not.toMatch(/VisitBriefModel|sharevisits/);
  });

  test("stays off in production without a cron secret, rather than poking unauthenticated", () => {
    expect(source).toMatch(/Boolean\(appUrl\) && \(Boolean\(secret\) \|\| !isProduction\)/);
  });
});
