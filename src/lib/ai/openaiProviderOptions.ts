/**
 * Provider options for every `openai(...)` call (AI SDK Responses API).
 *
 * The Responses API stores each response by default (about 30 days, visible in the
 * OpenAI dashboard). Customer PDF text and page images must not be retained there.
 */
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";

export const OPENAI_PROVIDER_OPTIONS = {
  openai: { store: false } satisfies OpenAIResponsesProviderOptions,
};
