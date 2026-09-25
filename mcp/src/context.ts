/**
 * Per-session context handed to every tool: the REST client bound to the caller's key, the
 * workspace identity from `initialize`, and process-wide services.
 */
import type { ApiClient, Whoami } from "./api";
import type { Config } from "./config";
import type { IdempotencyStore } from "./idempotency";

export type ToolContext = {
  config: Config;
  api: ApiClient;
  /** Identity captured at `initialize` (refreshed by `lnkdrp_whoami`). */
  whoami: () => Whoami;
  setWhoami: (next: Whoami) => void;
  /** Process-wide idempotency cache (keys are namespaced by orgId and credential, so sharing is safe). */
  idempotency: IdempotencyStore;
};
