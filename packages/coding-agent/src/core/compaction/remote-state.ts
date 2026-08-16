import type { Usage } from "@earendil-works/pi-ai";
import type {
	OpenAIResponsesCompaction,
	ResponsesCompactionIdentity,
} from "@earendil-works/pi-ai/api/openai-responses";
import type { CompactionKind } from "./compaction.ts";

export const PRIVATE_REMOTE_SCHEMA_VERSION = 1;
export const PRIVATE_REMOTE_JSONL_KEY = "_privateRemote";
export const REMOTE_COMPACTION_SUMMARY = "Remote compaction";
export const CLASSIC_FALLBACK_NOTICE = "Remote compaction unavailable; used classic compaction";

export interface PrivateRemoteState {
	schemaVersion: typeof PRIVATE_REMOTE_SCHEMA_VERSION;
	identity: ResponsesCompactionIdentity;
	output: unknown[];
	usage?: Usage;
}

export function publicCompactionKindLabel(kind: CompactionKind | undefined): string {
	if (kind === "remote") return "remote compaction";
	if (kind === "extension") return "extension compaction";
	return "classic compaction";
}

export function normalizeCompactionEndpoint(endpoint: string): string {
	try {
		const url = new URL(endpoint);
		const path = url.pathname.replace(/\/+$/, "") || "";
		return `${url.origin}${path}`;
	} catch {
		return endpoint.replace(/\/+$/, "");
	}
}

export function privateIdentitiesEqual(left: ResponsesCompactionIdentity, right: ResponsesCompactionIdentity): boolean {
	return (
		left.api === right.api &&
		left.model === right.model &&
		normalizeCompactionEndpoint(left.endpoint) === normalizeCompactionEndpoint(right.endpoint) &&
		left.deployment === right.deployment &&
		left.apiVersion === right.apiVersion
	);
}

export function isLegacyOpenAIResponsesDetails(details: unknown): details is {
	type: "openaiResponses";
	compaction: OpenAIResponsesCompaction;
} {
	if (!details || typeof details !== "object" || !("type" in details) || details.type !== "openaiResponses") {
		return false;
	}
	const compaction = (details as { compaction?: unknown }).compaction;
	return isPrivateRemoteCompaction(compaction);
}

export function isPrivateRemoteCompaction(value: unknown): value is OpenAIResponsesCompaction {
	if (!value || typeof value !== "object") return false;
	const compaction = value as Record<string, unknown>;
	const identity = compaction.identity;
	if (!identity || typeof identity !== "object") return false;
	const id = identity as Record<string, unknown>;
	if (typeof id.api !== "string" || typeof id.model !== "string" || typeof id.endpoint !== "string") return false;
	if (!Array.isArray(compaction.output)) return false;
	return compaction.output.every((item) => item && typeof item === "object" && ("type" in item || "role" in item));
}

export function extractPrivateRemoteState(raw: unknown): {
	publicDetails: unknown;
	privateRemote?: PrivateRemoteState;
	remoteEnvelopePresent: boolean;
} {
	if (!raw || typeof raw !== "object") {
		return { publicDetails: raw, remoteEnvelopePresent: false };
	}
	const record = raw as Record<string, unknown>;
	if (PRIVATE_REMOTE_JSONL_KEY in record) {
		const parsed = parsePrivateEnvelope(record[PRIVATE_REMOTE_JSONL_KEY]);
		const { [PRIVATE_REMOTE_JSONL_KEY]: _ignored, ...rest } = record;
		const publicDetails = Object.keys(rest).length === 0 ? undefined : rest;
		return parsed
			? { publicDetails, privateRemote: parsed, remoteEnvelopePresent: true }
			: { publicDetails, remoteEnvelopePresent: true };
	}
	if (record.type === "openaiResponses") {
		if (isLegacyOpenAIResponsesDetails(raw)) {
			return {
				publicDetails: undefined,
				privateRemote: {
					schemaVersion: PRIVATE_REMOTE_SCHEMA_VERSION,
					identity: raw.compaction.identity,
					output: raw.compaction.output,
					usage: raw.compaction.usage,
				},
				remoteEnvelopePresent: true,
			};
		}
		return { publicDetails: undefined, remoteEnvelopePresent: true };
	}
	return { publicDetails: raw, remoteEnvelopePresent: false };
}

function parsePrivateEnvelope(value: unknown): PrivateRemoteState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== PRIVATE_REMOTE_SCHEMA_VERSION) return undefined;
	if (!isPrivateRemoteCompaction({ identity: record.identity, output: record.output, usage: record.usage })) {
		return undefined;
	}
	return {
		schemaVersion: PRIVATE_REMOTE_SCHEMA_VERSION,
		identity: record.identity as ResponsesCompactionIdentity,
		output: record.output as unknown[],
		usage: record.usage as Usage | undefined,
	};
}

export function toOpenAIResponsesCompaction(state: PrivateRemoteState): OpenAIResponsesCompaction {
	return {
		identity: state.identity,
		output: structuredClone(state.output) as OpenAIResponsesCompaction["output"],
		usage: state.usage ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

export function attachPrivateEnvelope(publicDetails: unknown, privateRemote: PrivateRemoteState): unknown {
	const base =
		publicDetails && typeof publicDetails === "object" && !Array.isArray(publicDetails)
			? { ...(publicDetails as Record<string, unknown>) }
			: {};
	base[PRIVATE_REMOTE_JSONL_KEY] = {
		schemaVersion: privateRemote.schemaVersion,
		identity: privateRemote.identity,
		output: privateRemote.output,
		usage: privateRemote.usage,
	};
	return base;
}

export function containsOpaqueCompactionSentinel(value: unknown, sentinels: string[]): boolean {
	const serialized = JSON.stringify(value);
	return sentinels.some((sentinel) => serialized.includes(sentinel));
}
