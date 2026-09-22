/**
 * Two things the share viewer showed a recipient that were never written for them.
 *
 * - The version-history drawer rendered the server's response body. `loadMoreHistory` did
 *   `throw new Error(await res.text())` on any non-ok reply and the catch put that message straight
 *   into the red panel, so a reader whose link was revoked while their tab sat open was shown the
 *   literal string `{"error":"Not found"}`. `/s/:shareId/changes` answers JSON for every refusal it
 *   has (404 gone/revoked/expired/archived, 403 history off or off-plan, 401 lapsed share cookie,
 *   400 bad request), so the calm sentence sitting beside it as a fallback was unreachable. The
 *   browser's own text arrived the same way: a dropped connection wrote `Failed to fetch`, the 10s
 *   abort wrote `The user aborted a request`. The panel now shows only sentences this component
 *   wrote, which is what `HistoryMessageError` marks.
 *
 * - "Open PDF directly", in the native-PDF fallback, navigated to `/s/:shareId/pdf` without asking
 *   whether the sender allows downloads. A top-level open is stamped `sec-fetch-dest: document`,
 *   which is precisely what that route's `isRawFileRequest` gate catches, so on a no-download link
 *   (25 of the 28 seeded ones) the button opened a tab containing the two words "Download
 *   disabled", with no branding and no way back, offered to a reader whose viewer had just failed
 *   on them. Both anchors are now gated on `allowDownload`, the same flag the route gates on.
 *
 * The drawer and the fallback banner are only reachable through a rendered client component, and
 * this suite has no DOM, so the mapping is exercised for real and the two call sites are pinned by
 * reading the source, the same shape as tests/lib/liveProjectScope.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  HISTORY_ERROR_FALLBACK,
  HistoryMessageError,
  historyErrorForStatus,
} from "@/components/PdfJsViewer";

const ROOT = join(__dirname, "../..");
const SOURCE = readFileSync(join(ROOT, "src/components/PdfJsViewer.tsx"), "utf8");

describe("version-history refusals read as sentences", () => {
  test("every status the route can answer maps to prose, never to JSON", () => {
    // Every status `/s/:shareId/changes` answers with, plus the ones a proxy in front of it can.
    const mapped = [401, 403, 404, 410, 400, 500, 502].map((s) => historyErrorForStatus(s));
    for (const message of mapped) {
      expect(message).not.toMatch(/[{}]/);
      expect(message).not.toMatch(/"error"/);
      expect(message.trim().length).toBeGreaterThan(10);
      expect(message.trim()).toMatch(/[.!]$/);
    }
    expect(historyErrorForStatus(404)).not.toBe(historyErrorForStatus(403));
    expect(historyErrorForStatus(401)).toMatch(/password/i);
    expect(historyErrorForStatus(400)).toBe(HISTORY_ERROR_FALLBACK);
    expect(historyErrorForStatus(503)).toBe(HISTORY_ERROR_FALLBACK);
  });

  test("only messages written here are recipient-facing", () => {
    // What the catch has to be able to tell apart: ours, versus fetch's and the abort's.
    expect(new HistoryMessageError("x") instanceof Error).toBe(true);
    expect(new TypeError("Failed to fetch") instanceof HistoryMessageError).toBe(false);
    expect(new Error('{"error":"Not found"}') instanceof HistoryMessageError).toBe(false);
  });

  test("the refusal branch throws a mapped message, not the response body", () => {
    expect(SOURCE).not.toContain("throw new Error(text");
    expect(SOURCE).toContain("throw new HistoryMessageError(historyErrorForStatus(res.status))");
  });

  test("the history catch renders nothing it did not write", () => {
    // The one `setHistoryError` that is fed by a thrown error rather than by `null`.
    const setFromError = SOURCE.indexOf("setHistoryError(message");
    expect(setFromError).toBeGreaterThan(0);
    const catchBlock = SOURCE.slice(SOURCE.lastIndexOf("} catch (e) {", setFromError), setFromError + 80);
    expect(catchBlock).toContain("e instanceof HistoryMessageError");
    expect(catchBlock).not.toContain("e instanceof Error ? e.message");
  });
});

describe("the native-PDF fallback never offers a link the route will refuse", () => {
  test("both 'Open PDF directly' anchors are gated on allowDownload", () => {
    const offsets: number[] = [];
    for (let i = SOURCE.indexOf("Open PDF directly"); i >= 0; i = SOURCE.indexOf("Open PDF directly", i + 1)) {
      offsets.push(i);
    }
    // The simplified-view banner and the native-viewer failure panel. A third one arriving later
    // should land here rather than in a recipient's blank tab.
    expect(offsets).toHaveLength(2);
    for (const at of offsets) {
      const before = SOURCE.slice(Math.max(0, at - 700), at);
      const anchorAt = before.lastIndexOf("<a");
      expect(anchorAt).toBeGreaterThan(-1);
      const guard = before.slice(0, anchorAt);
      expect(guard).toMatch(/\ballowDownload \?/);
      // The href is still the raw file, so the guard has to be the same flag the route reads.
      expect(before.slice(anchorAt)).toContain("href={url}");
    }
  });

  test("a no-download reader is offered the ask instead of the dead end", () => {
    expect(SOURCE).toContain("Request download");
  });
});
