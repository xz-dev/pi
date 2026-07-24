import type { Model, ProviderStreams } from "../types.ts";
import { OPENAI_RESPONSES_COMPACTION_ADAPTER } from "../types.ts";
import { lazyApi } from "./lazy.ts";
import type { OpenAIResponsesCheckpointIdentity } from "./openai-responses.ts";

export type {
	OpenAIResponsesCheckpoint,
	OpenAIResponsesCheckpointIdentity,
	OpenAIResponsesCompactionAdapter,
	OpenAIResponsesCompactionOptions,
	OpenAIResponsesOptions,
	OpenAIResponsesProviderState,
} from "./openai-responses.ts";

export function normalizeOpenAIResponsesCompactionEndpoint(baseUrl: string): string {
	let endpoint: URL;
	try {
		endpoint = new URL(baseUrl);
	} catch {
		throw new Error("OpenAI Responses native compaction requires an absolute base URL");
	}
	endpoint.hash = "";
	endpoint.search = "";
	endpoint.username = "";
	endpoint.password = "";
	endpoint.hostname = endpoint.hostname.toLowerCase();
	endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") || "/";
	return endpoint.toString().replace(/\/$/, "");
}

export function getOpenAIResponsesCheckpointIdentity(
	model: Model<"openai-responses">,
): Readonly<OpenAIResponsesCheckpointIdentity> | undefined {
	const declared = model.compat?.responsesCompaction;
	if (
		declared?.adapter !== OPENAI_RESPONSES_COMPACTION_ADAPTER ||
		typeof declared.realm !== "string" ||
		declared.realm.trim().length === 0 ||
		typeof declared.modelFamily !== "string" ||
		declared.modelFamily.trim().length === 0
	) {
		return undefined;
	}
	return Object.freeze({
		adapter: OPENAI_RESPONSES_COMPACTION_ADAPTER,
		realm: declared.realm,
		provider: model.provider,
		endpoint: normalizeOpenAIResponsesCompactionEndpoint(model.baseUrl),
		modelFamily: declared.modelFamily,
	});
}

export const openAIResponsesApi = (): ProviderStreams => lazyApi(() => import("./openai-responses.ts"));
