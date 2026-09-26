/**
 * What the automatic compare is allowed to charge, and when it is allowed to skip the work.
 *
 * `POST /api/uploads/:uploadId/process` runs the version compare from two near-identical blocks:
 * the replacement path (an upload claimed `uploaded -> processing`) and the completed-upload
 * backfill (an upload that finished without a DocChange). Three defects lived across them, and all
 * three came from one habit - deciding credits from what the caller *expects* `runDocChangeDiff` to
 * do, rather than from what it actually did:
 *
 * - **The caller's no-change test was weaker than the callee's.** The replacement path called the
 *   compare with no reservation whenever normalized text matched and no page reported
 *   `imageChanged`. The short-circuit inside `runDocChangeDiff` (src/lib/ai/docChangeDiff.ts) also
 *   requires that the page count held and that there was evidence either way. Replace a PDF whose
 *   text is identical while the page count moves and the two disagree: a real paid model call, with
 *   no timeout, no usage telemetry, and nobody charged.
 *
 * - **The backfill had no no-change test at all, and passed no page counts.** It reserved and
 *   charged the full history price up front, so an identical re-upload paid 2/5/12 credits for a
 *   compare that produced the fixed "no changes" record without calling anything.
 *
 * - **A `charged` reservation was read as proof the compare had been stored.** It is not: an
 *   attempt that reserved, called the model, was charged and then died before the DocChange upsert
 *   leaves exactly that state. The retry then stored the empty placeholder diff and moved on, so
 *   the workspace had paid and version history showed nothing - for ever, because the reservation
 *   stays charged.
 *
 * - **Settling on observed usage had no gate on who may be billed.** Fixing the first defect put
 *   the page counts on the one remaining call site, which is what let the free leg reach the
 *   model - and the retroactive charge that catches it asked only whether the model ran, never
 *   whether this upload was allowed to cost the owner anything. The free leg is also the leg a
 *   recipient's replacement and a compare-off workspace land on, so both became billable: the
 *   owner charged the full history price for a stranger's upload, over the top of the `skipped`
 *   state and the "not run on the owner's credits" note the same block had just written.
 *
 * The fix removes the prediction three ways over. `runDocChangeDiff` calls `onUsage` once after a
 * model call and never on the paths that skip it, so "did we buy anything" is a fact rather than a
 * guess; the caller's no-change test is now `isUnchangedWithoutModel`, the callee's own rule rather
 * than a copy of it; and the leg with no reservation behind it passes `noModel`, so it cannot reach
 * the model even if those two ever disagree again. These tests evaluate the shipped expressions out
 * of the route source, the way `processCompareCredits.test.ts` and `recipientProcessGuards.test.ts`
 * do: the bugs were in those lines, so those lines are what run here rather than a paraphrase.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { isUnchangedWithoutModel, runDocChangeDiff } from "@/lib/ai/docChangeDiff";

const REPO_ROOT = path.resolve(__dirname, "../..");
const PROCESS_ROUTE = "src/app/api/uploads/[uploadId]/process/route.ts";

const source = fs.readFileSync(path.join(REPO_ROOT, PROCESS_ROUTE), "utf8");

/** The completed-upload backfill block, from its idempotency key to the run that follows it. */
function backfillBlock(): string {
  const from = source.indexOf("history:auto:${String(docId)}:to:${toVersion}");
  const to = source.indexOf("// Best-effort: store a DocChange record for replacement uploads");
  expect(from, "the backfill still keys its reservation on the version").toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

/** The replacement block: the real "compare every replacement" path. */
function replacementBlock(): string {
  const from = source.indexOf("history:auto:${String(docId)}:to:${uploadVersion}");
  const to = source.indexOf("// Best-effort: attach slide thumbnails");
  expect(from, "the replacement path still keys its reservation on the version").toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

/** Pull `const <name> = <expr>;` out of the route and compile the expression so the real one runs. */
function expression(name: string, params: string[]): (...args: unknown[]) => unknown {
  const m = source.match(new RegExp(`const ${name} =([\\s\\S]*?);\\n`));
  expect(m?.[1], `the route still decides in \`const ${name} = ...\``).toBeTruthy();
  return new Function(...params, `return (${m![1]});`) as (...args: unknown[]) => unknown;
}

/** A usage report shaped like the one `runDocChangeDiff` hands to `onUsage` after a model call. */
const USAGE = {
  inputTokens: 18_000,
  outputTokens: 400,
  imagesAttached: 6,
  pagesAttached: 3,
  qualityTier: "standard",
  model: "gpt-x-vision",
};
const DIFF = { summary: "Raise moved from $4M to $6M.", changes: [{ kind: "text" }], pagesThatChanged: [3] };
const NO_CHANGE_DIFF = { summary: "No changes: this version reads the same as the previous one.", changes: [], pagesThatChanged: [] };

/** `const <name> = <expr>;` taken out of one block, so the backfill's twin cannot be picked up instead. */
function blockExpression(block: string, name: string, params: string[]): (...args: any[]) => any {
  const m = block.match(new RegExp(`const ${name} =([\\s\\S]*?);\\n`));
  expect(m?.[1], `the replacement block still decides in \`const ${name} = ...\``).toBeTruthy();
  return new Function(...params, `return (${m![1]});`) as (...args: any[]) => any;
}

/** The replacement path's "may this workspace be charged for this compare at all". */
function historyBillableGate(f: { viaUploadSecret: boolean; automationCompareOn: boolean }): boolean {
  return Boolean(
    blockExpression(replacementBlock(), "historyBillable", ["viaUploadSecret", "automationCompareOn"])(
      f.viaUploadSecret,
      f.automationCompareOn,
    ),
  );
}

/** The replacement path's reservation gate. */
function historyAllowedGate(f: { viaUploadSecret: boolean; automationCompareOn: boolean; nothingChanged: boolean }): boolean {
  return Boolean(
    blockExpression(replacementBlock(), "historyAllowed", ["viaUploadSecret", "nothingChanged", "automationCompareOn"])(
      f.viaUploadSecret,
      f.nothingChanged,
      f.automationCompareOn,
    ),
  );
}

/** The shipped retro-charge condition, evaluated against the facts that decide it. */
function retroCharge(f: {
  usage: unknown;
  historyAlreadyPaid: boolean;
  viaUploadSecret: boolean;
  automationCompareOn: boolean;
}): boolean {
  const m = replacementBlock().match(/\} else if \(compareRun\.usage !== null &&([^)]*)\) \{/);
  expect(m?.[1], "the retro-charge is still an `else if` on the observed usage").toBeTruthy();
  const test = new Function(
    "compareRun",
    "historyAlreadyPaid",
    "historyBillable",
    `return Boolean(compareRun.usage !== null && ${m![1]});`,
  ) as (a: unknown, b: boolean, c: boolean) => boolean;
  return test({ usage: f.usage }, f.historyAlreadyPaid, historyBillableGate(f));
}

// --- 1. a charge follows the model call, not the caller's expectation ----------------------------

describe("only a compare that reached the model is chargeable", () => {
  test("both blocks settle on the usage report, not on having got there", () => {
    const chargeable = [
      expression("compareChargeable", ["diff", "compareRun"]),
      expression("backfillChargeable", ["diff", "backfillRun"]),
    ];
    for (const isChargeable of chargeable) {
      // The model ran and produced a diff: this is the ordinary paid compare.
      expect(isChargeable(DIFF, { usage: USAGE })).toBe(true);
      // The callee answered from its short-circuit: nothing was bought, so nothing may be charged.
      expect(isChargeable(NO_CHANGE_DIFF, { usage: null })).toBe(false);
      // The model ran and came back with nothing usable: refund, do not charge for a blank compare.
      expect(isChargeable(null, { usage: USAGE })).toBe(false);
      // No key configured, or empty text on one side: `runDocChangeDiff` returns null unbilled.
      expect(isChargeable(null, { usage: null })).toBe(false);
    }
  });

  test("the identical re-upload is refunded rather than charged", () => {
    // The whole of defect 2: the backfill reserved the full history price and charged it on any
    // non-null diff, and the fixed "no changes" record is non-null.
    const isChargeable = expression("backfillChargeable", ["diff", "backfillRun"]);
    expect(isChargeable(NO_CHANGE_DIFF, { usage: null })).toBe(false);
    expect(backfillBlock()).toContain("failAndRefundLedger");
  });

  test("nothing settles a compare from `nothingChanged` or from `historyAllowed`", () => {
    // Those are the caller's predictions. If either one is what decides the charge, the two tests
    // can disagree again the next time the short-circuit gains a condition.
    const chargeable = [
      source.match(/const compareChargeable =([\s\S]*?);\n/)![1]!,
      source.match(/const backfillChargeable =([\s\S]*?);\n/)![1]!,
    ];
    for (const expr of chargeable) {
      expect(expr).not.toContain("nothingChanged");
      expect(expr).not.toContain("historyAllowed");
      expect(expr).toContain("usage");
    }
  });
});

// --- 2. one call site per block, carrying the ceiling, the counts and the telemetry ---------------

describe("every compare runs through one call, fully equipped", () => {
  test("the replacement path calls the compare exactly once", () => {
    // It called it twice: a bare "free" call for the no-change case and the real one. The bare call
    // was the one that could reach the model uncapped, unrecorded and unbilled.
    const calls = replacementBlock().match(/runDocChangeDiff\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  test("the backfill calls the compare exactly once", () => {
    const calls = backfillBlock().match(/runDocChangeDiff\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  test("both calls pass the page counts, the timeout and the usage callback", () => {
    for (const block of [replacementBlock(), backfillBlock()]) {
      // Page counts: without them the callee cannot tell "identical text" from "identical text but
      // five more pages", which is the disagreement that cost the money.
      expect(block).toContain("previousPageCount");
      expect(block).toContain("newPageCount");
      // The ceiling: a hung compare inside `after()` takes the whole job down with it.
      expect(block).toContain("abortSignal: AbortSignal.timeout(COMPARE_TIMEOUT_MS)");
      // The usage callback is both the telemetry and the settle's only input.
      expect(block).toContain("onUsage:");
      expect(block).toContain("compareTelemetry(");
    }
  });
});

// --- 3. what still runs, and what still costs nothing ---------------------------------------------

describe("the compare runs when it must and skips when it must", () => {
  const shouldRun = () => expression("compareShouldRun", ["historyAlreadyDone", "historyLedgerId", "historyAlreadyPaid", "nothingChanged"]);

  test("an ordinary reserved replacement runs", () => {
    expect(shouldRun()(false, "ledger-1", false, false)).toBe(true);
  });

  test("an identical re-upload still gets its record, and still reserves nothing", () => {
    // The deliberate free path (owner, 2026-09-17): a re-upload of the same file writes the fixed
    // "no changes" record instead of an invented list of edits, and costs nothing to do it.
    expect(shouldRun()(false, null, false, true)).toBe(true);
    // It is still kept out of the reservation: `historyAllowed` refuses it, so no credits move.
    expect(historyAllowedGate({ viaUploadSecret: false, automationCompareOn: true, nothingChanged: true })).toBe(false);
  });

  test("a recipient upload runs no compare at all", () => {
    // The owner never pays for a stranger's upload, so a recipient replacement with changed text
    // reserves nothing and runs nothing.
    expect(shouldRun()(false, null, false, false)).toBe(false);
  });

  test("a workspace that could not reserve runs nothing", () => {
    // Out of credits, daily cap, or the compare switch off: same shape, no ledger, no run.
    expect(shouldRun()(false, null, false, false)).toBe(false);
  });
});

// --- 4. a charged reservation is not proof the result was stored ----------------------------------

describe("a paid compare that stored nothing is produced again, free", () => {
  test("the replacement path asks whether the DocChange exists, and re-runs when it does not", () => {
    const block = replacementBlock();
    expect(block).toContain("historyAlreadyPaid = !historyAlreadyDone;");
    const shouldRun = expression("compareShouldRun", [
      "historyAlreadyDone",
      "historyLedgerId",
      "historyAlreadyPaid",
      "nothingChanged",
    ]);
    // Charged, nothing stored: re-run it. The old code skipped and wrote the empty placeholder.
    expect(shouldRun(false, null, true, false)).toBe(true);
    // Charged and stored: leave it alone, and leave its DocChange alone.
    expect(shouldRun(true, null, false, false)).toBe(false);
    expect(source).toContain("if (!historyAlreadyDone) await DocChangeModel.updateOne(");
  });

  test("the re-run is not charged a second time", () => {
    // The workspace already paid for this version's compare; the retro-charge exists for a
    // different case (the free path reaching the model) and must not fire here.
    expect(retroCharge({ usage: USAGE, historyAlreadyPaid: true, viaUploadSecret: false, automationCompareOn: true })).toBe(false);
  });

  test("the backfill re-runs a charged-but-unstored version too", () => {
    const block = backfillBlock();
    expect(block).toContain("historyAlreadyPaid = true;");
    const shouldRun = expression("backfillShouldRun", ["historyLedgerId", "historyAlreadyPaid"]);
    expect(shouldRun(null, true)).toBe(true);
    expect(shouldRun("ledger-1", false)).toBe(true);
    expect(shouldRun(null, false)).toBe(false);
  });

  test("the backfill only reaches that state with nothing stored", () => {
    // It runs inside `if (!existing)`, so a `charged` replay there can only mean the paid attempt
    // died before its upsert. That is why it may re-run without asking anything else.
    const block = backfillBlock();
    const guard = source.lastIndexOf("const existing = await DocChangeModel.exists({ docId, toUploadId: upload._id });", source.indexOf(block));
    expect(guard).toBeGreaterThan(0);
  });
});

// --- 5. the free path may not bill anyone, and may not reach the model ----------------------------

/**
 * One replacement, run end to end over the shipped expressions.
 *
 * The defect this pins is not in any single line: it is what the lines do together. The caller's
 * own no-change test decided the run was free, the free run reached the model anyway because the
 * callee's test was stronger, and the settle then charged for the call it observed - with no gate
 * left anywhere on whether this particular upload was ever allowed to cost the owner anything.
 * Each piece is defensible alone, so each piece is evaluated here in the order the route uses it.
 */
function simulate(f: {
  viaUploadSecret: boolean;
  automationCompareOn: boolean;
  previousText: string;
  newText: string;
  previousPageCount?: number | null;
  newPageCount?: number | null;
  changedPages?: Array<{ imageChanged?: boolean | null }>;
}): { ranModel: boolean; charged: boolean } {
  const block = replacementBlock();
  // Exactly what the route now asks, and it asks the callee's own rule rather than a copy of it.
  const nothingChanged = isUnchangedWithoutModel({
    previousText: f.previousText,
    newText: f.newText,
    changedPages: f.changedPages ?? [],
    previousPageCount: f.previousPageCount ?? null,
    newPageCount: f.newPageCount ?? null,
  });
  const historyAllowed = historyAllowedGate({ ...f, nothingChanged });
  // A workspace with credits: the reservation succeeds whenever it is attempted.
  const historyLedgerId = historyAllowed ? "ledger-1" : null;
  const historyAlreadyPaid = false;
  const shouldRun = Boolean(
    blockExpression(block, "compareShouldRun", [
      "historyAlreadyDone",
      "historyLedgerId",
      "historyAlreadyPaid",
      "nothingChanged",
    ])(false, historyLedgerId, historyAlreadyPaid, nothingChanged),
  );
  const recordOnly = Boolean(
    blockExpression(block, "compareRecordOnly", ["historyLedgerId", "historyAlreadyPaid"])(historyLedgerId, historyAlreadyPaid),
  );
  // `noModel` is handed straight to `runDocChangeDiff`, which returns before the model when it is
  // set, so `onUsage` can only fire on a run that did not pass it.
  expect(block).toContain("noModel: compareRecordOnly");
  const ranModel = shouldRun && !recordOnly && !nothingChanged;
  const usage = ranModel ? USAGE : null;
  const charged =
    (historyLedgerId !== null && usage !== null) ||
    retroCharge({ usage, historyAlreadyPaid, viaUploadSecret: f.viaUploadSecret, automationCompareOn: f.automationCompareOn });
  return { ranModel, charged };
}

/** Identical extractable text, one page appended with no text layer: the case that cost the money. */
const PAGE_APPENDED = {
  previousText: "Series A. Raising $4M.",
  newText: "Series A. Raising $4M.",
  previousPageCount: 13,
  newPageCount: 18,
};

describe("a compare nobody agreed to pay for is never bought", () => {
  test("a recipient replacement never bills the owner, page count moved or not", () => {
    // The documented rule, stated twice in the route: capability callers must never be able to
    // trigger owner-billed actions, and a recipient upload is not run on the owner's credits.
    // It held only because the free call used to pass no page counts, so the callee always
    // short-circuited. Give the callee the counts and the model runs - and the settle, which had
    // no billability gate, charged the owner the full history price for a stranger's upload.
    expect(simulate({ viaUploadSecret: true, automationCompareOn: true, ...PAGE_APPENDED })).toEqual({
      ranModel: false,
      charged: false,
    });
    expect(
      simulate({ viaUploadSecret: true, automationCompareOn: true, previousText: "old raise", newText: "new raise" }),
    ).toEqual({ ranModel: false, charged: false });
  });

  test("a workspace with automatic compares switched off is never billed for one", () => {
    expect(simulate({ viaUploadSecret: false, automationCompareOn: false, ...PAGE_APPENDED })).toEqual({
      ranModel: false,
      charged: false,
    });
    expect(
      simulate({ viaUploadSecret: false, automationCompareOn: false, previousText: "old raise", newText: "new raise" }),
    ).toEqual({ ranModel: false, charged: false });
  });

  test("the owner, with compares on, gets the real compare and reserves for it up front", () => {
    // The other half of the same fix: a page appended is a real change, so this is not a free run
    // that gets charged after the fact - it reserves first, like every other paid compare.
    expect(simulate({ viaUploadSecret: false, automationCompareOn: true, ...PAGE_APPENDED })).toEqual({
      ranModel: true,
      charged: true,
    });
  });

  test("a genuinely identical re-upload still costs nothing, for anyone", () => {
    // The deliberate free path (owner, 2026-09-17), unchanged: same text, same page count.
    for (const viaUploadSecret of [false, true]) {
      for (const automationCompareOn of [false, true]) {
        expect(
          simulate({
            viaUploadSecret,
            automationCompareOn,
            previousText: "Series A. Raising $4M.",
            newText: "Series A. Raising $4M.",
            previousPageCount: 13,
            newPageCount: 13,
          }),
        ).toEqual({ ranModel: false, charged: false });
      }
    }
  });

  test("the retro-charge asks who uploaded and whether the feature is on", () => {
    // Evaluated directly, because `noModel` means the simulator above can no longer reach it: if a
    // later change lets a free run touch the model again, this is the clause that decides who pays.
    expect(retroCharge({ usage: USAGE, historyAlreadyPaid: false, viaUploadSecret: true, automationCompareOn: true })).toBe(false);
    expect(retroCharge({ usage: USAGE, historyAlreadyPaid: false, viaUploadSecret: false, automationCompareOn: false })).toBe(false);
    expect(retroCharge({ usage: USAGE, historyAlreadyPaid: false, viaUploadSecret: false, automationCompareOn: true })).toBe(true);
    expect(retroCharge({ usage: null, historyAlreadyPaid: false, viaUploadSecret: false, automationCompareOn: true })).toBe(false);
  });

  test("the reservation gate and the billing gate say the same thing", () => {
    // They are written out separately - `processCompareCredits.test.ts` compiles the reservation
    // gate literally - so the relationship between them is pinned here instead of by construction.
    // If one grows a clause the other does not, this is where it shows up rather than in a ledger.
    for (const viaUploadSecret of [false, true]) {
      for (const automationCompareOn of [false, true]) {
        for (const nothingChanged of [false, true]) {
          const f = { viaUploadSecret, automationCompareOn, nothingChanged };
          expect(historyAllowedGate(f)).toBe(historyBillableGate(f) && !nothingChanged);
        }
      }
    }
  });

  test("the compare-off switch is read on every path the answer can be billed on", () => {
    // It used to be short-circuited to `true` whenever the text looked unchanged, which was safe
    // only while nothing downstream read it. The moment the settle needed to know whether this
    // workspace may be billed, that stand-in was a lie on exactly the path that could be billed.
    const block = replacementBlock();
    expect(block).toContain("const automationCompareOn = viaUploadSecret");
    expect(block).not.toContain("viaUploadSecret || nothingChanged");
  });
});

describe("the caller no longer keeps its own copy of the no-change rule", () => {
  test("the route asks `isUnchangedWithoutModel`, with the page counts", () => {
    const block = replacementBlock();
    expect(block).toContain("const nothingChanged = isUnchangedWithoutModel({");
    // The paraphrase that drifted: text equality plus per-page image verdicts, and nothing about
    // the page count or about there being no evidence either way.
    expect(block).not.toContain("normalizeForCompare(previousText) === normalizeForCompare(newText)");
    for (const arg of ["previousPageCount", "newPageCount", "changedPages"]) expect(block).toContain(arg);
  });

  test("the shared rule refuses to call a page-count move `no change`", () => {
    expect(isUnchangedWithoutModel({ previousText: "a", newText: "a", previousPageCount: 13, newPageCount: 13 })).toBe(true);
    expect(isUnchangedWithoutModel({ previousText: "a", newText: "a", previousPageCount: 13, newPageCount: 18 })).toBe(false);
    // Two empty texts and no image verdict is not evidence of sameness.
    expect(isUnchangedWithoutModel({ previousText: "", newText: "" })).toBe(false);
    expect(isUnchangedWithoutModel({ previousText: "", newText: "", changedPages: [{ imageChanged: false }] })).toBe(true);
    expect(isUnchangedWithoutModel({ previousText: "a", newText: "a", changedPages: [{ imageChanged: true }] })).toBe(false);
  });

  test("`noModel` returns rather than spend, and never reports usage", async () => {
    // The record-only path's guarantee: the caller cannot be handed a paid call it never reserved
    // for, whatever the short-circuit decides.
    let usageReports = 0;
    const out = await runDocChangeDiff({
      previousText: "Series A. Raising $4M.",
      newText: "Series A. Raising $4M.",
      previousPageCount: 13,
      newPageCount: 18,
      noModel: true,
      onUsage: () => {
        usageReports += 1;
      },
    });
    expect(out).toBeNull();
    expect(usageReports).toBe(0);
    // The record it does still produce, free, when the two versions really are the same.
    const same = await runDocChangeDiff({
      previousText: "Series A. Raising $4M.",
      newText: "Series A. Raising $4M.",
      previousPageCount: 13,
      newPageCount: 13,
      noModel: true,
      onUsage: () => {
        usageReports += 1;
      },
    });
    expect(same?.changes).toEqual([]);
    expect(usageReports).toBe(0);
  });
});
