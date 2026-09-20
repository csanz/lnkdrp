import { describe, expect, test } from "vitest";

import { confirmationsSkipRequestedButUnsafe } from "../../mcp/src/confirm";

/**
 * The dev escape hatch that turns off delete prompts, and the one distinction it rests on.
 *
 * Skipping is gated on the *data* being a dev database, not on where the server process runs. A
 * local MCP pointed at https://lnkdrp.com is a supported setup — it is how filePath uploads work —
 * and in it a delete destroys a real document. So "am I running locally?" is the wrong question
 * and `LNKDRP_API_URL` is the right one.
 *
 * These test the refusal half via `confirmationsSkipRequestedButUnsafe`, which is true exactly when
 * the operator asked to skip and we declined. `skipConfirmations` itself is module-private because
 * nothing should be able to call it with a hand-made environment.
 */
const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv => ({ ...over }) as NodeJS.ProcessEnv;

describe("skipping delete confirmations", () => {
  test("not asked for means nothing is refused and nothing is skipped", () => {
    expect(confirmationsSkipRequestedButUnsafe(env({ LNKDRP_API_URL: "https://lnkdrp.com" }))).toBe(false);
    expect(confirmationsSkipRequestedButUnsafe(env({ LNKDRP_API_URL: "http://localhost:3001" }))).toBe(false);
  });

  test("asked for against a dev database is honoured", () => {
    for (const flag of ["1", "true", "yes", "TRUE"]) {
      expect(
        confirmationsSkipRequestedButUnsafe(
          env({ LNKDRP_SKIP_CONFIRMATIONS: flag, LNKDRP_API_URL: "http://localhost:3001" }),
        ),
        flag,
      ).toBe(false);
    }
  });

  /**
   * The case this gate exists for: the process is on a laptop, the data is production. Running a
   * local server against the production API is how filePath uploads work, so this is a setup people
   * are actively told to use — and a delete in it is a real delete.
   */
  test("asked for against production is refused, however local the process is", () => {
    expect(
      confirmationsSkipRequestedButUnsafe(
        env({ LNKDRP_SKIP_CONFIRMATIONS: "1", LNKDRP_API_URL: "https://lnkdrp.com" }),
      ),
    ).toBe(true);
  });

  test("a hostname that merely looks local is not local", () => {
    for (const url of ["https://localhost.evil.com", "https://notlocalhost", "https://127.0.0.1.evil.com"]) {
      expect(
        confirmationsSkipRequestedButUnsafe(env({ LNKDRP_SKIP_CONFIRMATIONS: "1", LNKDRP_API_URL: url })),
        url,
      ).toBe(true);
    }
  });

  test("the loopback forms are all accepted", () => {
    for (const url of ["http://localhost:3001", "http://127.0.0.1:3001", "http://[::1]:3001", "http://app.localhost"]) {
      expect(
        confirmationsSkipRequestedButUnsafe(env({ LNKDRP_SKIP_CONFIRMATIONS: "1", LNKDRP_API_URL: url })),
        url,
      ).toBe(false);
    }
  });

  test("an unset API URL follows the same default the config does", () => {
    // Outside production the API URL defaults to localhost, so the flag is honoured...
    expect(confirmationsSkipRequestedButUnsafe(env({ LNKDRP_SKIP_CONFIRMATIONS: "1" }))).toBe(false);
    // ...and in production it defaults to https://lnkdrp.com, so it is refused.
    expect(
      confirmationsSkipRequestedButUnsafe(env({ LNKDRP_SKIP_CONFIRMATIONS: "1", NODE_ENV: "production" })),
    ).toBe(true);
  });

  test("a value that is not an opt-in is not an opt-in", () => {
    for (const flag of ["0", "false", "no", "", "maybe"]) {
      expect(
        confirmationsSkipRequestedButUnsafe(
          env({ LNKDRP_SKIP_CONFIRMATIONS: flag, LNKDRP_API_URL: "https://lnkdrp.com" }),
        ),
        flag,
      ).toBe(false);
    }
  });
});
