/**
 * Two refusals that reached the agent with the recovery step missing.
 *
 * `owner_removed`: the REST layer answers a key whose creating member was removed from the
 * workspace with its own code and sentence, on purpose - "an agent told 'invalid key' when the real
 * answer is 'the person who made this key is no longer in the workspace' will retry forever with a
 * good key" (src/lib/gating/apiKeyActor.ts). The MCP mapper dropped that into the generic 401 case,
 * so the agent got "The API key was not accepted by lnkdrp." and, at connect time, the OAuth
 * sentence - both of which point at remedies that cannot work here.
 *
 * `rate_limited`: the limiter computes the seconds left in the window and sends them twice, as
 * `retryAfterSeconds` and as a `retry-after` header. Neither reached the caller, so the one number
 * that says when to come back was the one thing the refusal did not say.
 */
import { describe, expect, it } from "vitest";

import { initializeFailureResponse, mapApiError, ToolError } from "../../mcp/src/errors";

const where = { method: "GET", path: "/api/docs", siteUrl: "http://localhost:3001" };

describe("mapApiError: a key whose owner left the workspace", () => {
  it("keeps the cause instead of calling it a bad key", () => {
    const err = mapApiError({
      status: 401,
      body: { error: "owner_removed", message: "The member who created this API key is no longer in this workspace." },
      ...where,
    });
    expect(err.code).toBe("owner_removed");
    expect(err.message).not.toBe("The API key was not accepted by lnkdrp.");
    expect(err.details).toEqual({ reason: "owner_removed" });
  });

  it("names the remedy that works and rules out the two that do not", () => {
    const err = mapApiError({
      status: 401,
      body: { error: "owner_removed", message: "The member who created this API key is no longer in this workspace." },
      ...where,
    });
    // Making another key is the obvious move and it fails identically; the refusal has to say so.
    expect(err.message).toMatch(/new key created by the same person will fail the same way/i);
    expect(err.message).toMatch(/re-add them|key created by a current member/i);
  });

  it("still calls a genuinely bad key unauthorized", () => {
    const err = mapApiError({ status: 401, body: { error: "unauthorized", message: "Invalid API key." }, ...where });
    expect(err.code).toBe("unauthorized");
    expect(err.message).toBe("The API key was not accepted by lnkdrp.");
  });

  it("answers initialize with the same explanation rather than the OAuth sentence", () => {
    const err = mapApiError({
      status: 401,
      body: { error: "owner_removed", message: "The member who created this API key is no longer in this workspace." },
      ...where,
    });
    const out = initializeFailureResponse(err);
    expect(out.status).toBe(401);
    expect(out.body.error).toBe("owner_removed");
    expect(out.body.message).toMatch(/no longer in this workspace/i);
    // The 502 "could not reach the API" answer would send the human to look at our availability.
    expect(out.body.message).not.toMatch(/could not reach/i);
  });
});

describe("mapApiError: a key over its request limit", () => {
  const body = {
    error: "api_key_rate_limited",
    message: "This API key is over its limit of 300 requests per minute.",
    retryAfterSeconds: 37,
  };

  it("passes on the wait the limiter computed, in the message and in details", () => {
    const err = mapApiError({ status: 429, body, ...where });
    expect(err.code).toBe("rate_limited");
    expect(err.message).toContain("300 requests per minute");
    expect(err.message).toContain("Wait 37 seconds");
    expect(err.details).toEqual({ retryAfterSeconds: 37 });
  });

  it("says one second, not one seconds", () => {
    const err = mapApiError({ status: 429, body: { ...body, retryAfterSeconds: 1 }, ...where });
    expect(err.message).toContain("Wait 1 second and");
  });

  it("does not invent a wait when the route sent none", () => {
    const err = mapApiError({ status: 429, body: { error: "rate_limited" }, ...where });
    expect(err.code).toBe("rate_limited");
    expect(err.message).toMatch(/slow down and retry/i);
    expect(err.details).toBeUndefined();
  });

  it("carries the wait through the older routes that answer 400", () => {
    // Some routes catch the limiter themselves; the sentence is the same and so is the field.
    const err = mapApiError({ status: 400, body, ...where });
    expect(err.code).toBe("rate_limited");
    expect(err.details).toEqual({ retryAfterSeconds: 37 });
  });

  it("puts the wait in the initialize refusal too", () => {
    const out = initializeFailureResponse(mapApiError({ status: 429, body, ...where }));
    expect(out.status).toBe(429);
    expect(out.body.retryAfterSeconds).toBe(37);
  });

  it("leaves the field off an initialize refusal that never had a number", () => {
    const out = initializeFailureResponse(new ToolError("rate_limited", "This API key is over its limit of 300 requests per minute."));
    expect(out.status).toBe(429);
    expect(out.body.retryAfterSeconds).toBeUndefined();
  });
});
