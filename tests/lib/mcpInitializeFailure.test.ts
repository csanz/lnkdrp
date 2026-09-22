/**
 * A key over its request limit is told to slow down, not that the service is down.
 *
 * Found on 2026-09-22 by a volume run: seeding twenty documents and then verifying them put more
 * than 300 requests through one key inside a minute. The API said so plainly, and `initialize`
 * turned that into `502 upstream, "Could not reach the lnkdrp API to verify the key."` — which
 * points a client at our availability when the thing it needs to change is its own call rate.
 * Every later connection got the same 502 until the window rolled.
 */
import { describe, expect, it } from "vitest";

import { initializeFailureResponse, ToolError } from "../../mcp/src/errors";

describe("initializeFailureResponse", () => {
  it("answers 429 and repeats what the API said when the key is over its limit", () => {
    const err = new ToolError("rate_limited", "This API key is over its limit of 300 requests per minute.");
    const out = initializeFailureResponse(err);
    expect(out.status).toBe(429);
    expect(out.body.error).toBe("rate_limited");
    // The API's own sentence names the limit and the window; paraphrasing it would lose both.
    expect(out.body.message).toContain("300 requests per minute");
  });

  it("still answers 502 when the API genuinely could not be reached", () => {
    const out = initializeFailureResponse(new Error("ECONNREFUSED 127.0.0.1:3001"));
    expect(out.status).toBe(502);
    expect(out.body.error).toBe("upstream");
  });

  it("treats an unrecognised ToolError as upstream rather than guessing", () => {
    const out = initializeFailureResponse(new ToolError("upstream", "boom"));
    expect(out.status).toBe(502);
    expect(out.body.error).toBe("upstream");
  });
});
