import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const openAIResponsesApi = (): ProviderStreams & { readonly supportsBackgroundResponseReplay: true } => ({
	...lazyApi(() => import("./openai-responses.ts")),
	supportsBackgroundResponseReplay: true,
});
