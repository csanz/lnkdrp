/**
 * A refusal reports the count the workspace HAS, not the one the refused write would have reached.
 *
 * Found on 2026-09-22 by running the MCP coverage sweep against the Free personal workspace: it
 * held two projects, was refused a third, and the refusal said `used: 3, max: 2`. That number is
 * not a state the workspace was ever in, and it does not stay in the error — it is written to the
 * `plan.limit_reached` activity row and rendered to the owner as "3 of 2 used." while
 * `GET /api/plan` answered `used: 2` in the same minute.
 */
import { describe, expect, it } from "vitest";

import { planLimitUsageSuffix } from "../../src/lib/client/planLimit";

describe("planLimitUsageSuffix", () => {
  it("shows what the workspace holds, not what the refused write wanted", () => {
    // The shape a refusal now carries: two projects held, one asked for, cap of two.
    expect(planLimitUsageSuffix({ used: 2, requested: 1, max: 2 })).toBe("2 of 2 used.");
  });

  it("says how many more were asked for when a bulk add is refused", () => {
    // Without this the refusal reads "8 of 10 used." and leaves the reader wondering why it failed.
    expect(planLimitUsageSuffix({ used: 8, requested: 5, max: 10 })).toBe("8 of 10 used, 5 more requested.");
  });

  it("treats a missing or single request as the ordinary one-at-a-time case", () => {
    expect(planLimitUsageSuffix({ used: 3, max: 3 })).toBe("3 of 3 used.");
    expect(planLimitUsageSuffix({ used: 3, requested: 1, max: 3 })).toBe("3 of 3 used.");
  });

  it("stays empty for a feature gate, which has nothing to count", () => {
    // version_history / analytics_history / project_links are blocked with max 0.
    expect(planLimitUsageSuffix({ used: 0, requested: 0, max: 0 })).toBe("");
    expect(planLimitUsageSuffix({})).toBe("");
  });
});
