import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";
import type { OpenAICodexWebSocketDebugStats } from "./openai-codex-responses.ts";

export const openAICodexResponsesApi = (): ProviderStreams => lazyApi(() => import("./openai-codex-responses.ts"));

/**
 * Reads the WebSocket state the Codex API module keeps for a session, without a static
 * dependency on that module. Lets extensions that serve Codex streams observe transport
 * failures (`websocketFallbackActive`) when only the public package entry is available.
 */
export const getOpenAICodexWebSocketDebugStatsLazy = async (
	sessionId: string,
): Promise<OpenAICodexWebSocketDebugStats | undefined> =>
	(await import("./openai-codex-responses.ts")).getOpenAICodexWebSocketDebugStats(sessionId);

/**
 * Resets a session's (or every session's) Codex WebSocket stats, including the SSE fallback a
 * transport failure turns on, so the next request may try WebSocket again.
 */
export const resetOpenAICodexWebSocketDebugStatsLazy = async (sessionId?: string): Promise<void> =>
	(await import("./openai-codex-responses.ts")).resetOpenAICodexWebSocketDebugStats(sessionId);
