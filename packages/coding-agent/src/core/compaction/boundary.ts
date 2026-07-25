import { existsSync, readFileSync } from "node:fs";
import type { Usage } from "@earendil-works/pi-ai";
import { OPENAI_RESPONSES_COMPACTION_ADAPTER } from "@earendil-works/pi-ai";
import type {
	CompactionEntry,
	ProviderCheckpoint,
	ProviderCheckpointEntry,
	SessionEntryBase,
} from "../session-manager.ts";

export interface PortableCompactionProjection<T = unknown> {
	type: "portable_compaction_projection";
	version: 1;
	customType: string;
	summary: string;
	details?: T;
	usage?: Usage;
}

export interface StoredCompactionBoundaryEntry extends SessionEntryBase {
	type: "compaction_boundary";
	boundary: {
		version: 1;
		tokensBefore: number;
		primary:
			| {
					kind: "text";
					summary: string;
					firstKeptEntryId: string;
					details?: unknown;
					fromExtension: boolean;
					usage?: Usage;
			  }
			| {
					kind: "checkpoint";
					checkpoint: ProviderCheckpoint;
					usage?: Usage;
			  };
		projections: PortableCompactionProjection[];
	};
}

export interface CompactionBoundary {
	id: string;
	parentId: string | null;
	timestamp: string;
	version: 1;
	kind: "text" | "checkpoint";
	tokensBefore: number;
	text?: {
		summary: string;
		firstKeptEntryId: string;
		details?: unknown;
		fromExtension: boolean;
	};
	projections: PortableCompactionProjection[];
	usage?: Usage;
}

export interface CompactionBoundaryEntry extends SessionEntryBase {
	type: "compaction_boundary";
	boundary: CompactionBoundary;
}

interface CompactionOutcomeBase {
	boundaryEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
	usage?: Usage;
	projectionCount: number;
}

export interface TextCompactionOutcome extends CompactionOutcomeBase {
	kind: "text";
	summary: string;
	firstKeptEntryId: string;
	details?: unknown;
	fromExtension: boolean;
}

export interface CheckpointCompactionOutcome extends CompactionOutcomeBase {
	kind: "checkpoint";
}

export type CompactionOutcome = TextCompactionOutcome | CheckpointCompactionOutcome;
/** @deprecated Use CompactionOutcome. */
export type CompactionResult = CompactionOutcome;

export type CompactionBoundaryDraft = StoredCompactionBoundaryEntry["boundary"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function isJsonValue(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (!isRecord(value)) return false;
	return Object.values(value).every(isJsonValue);
}

function isUsage(value: unknown): value is Usage {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"input",
			"output",
			"cacheRead",
			"cacheWrite",
			"cacheWrite1h",
			"reasoning",
			"totalTokens",
			"cost",
		])
	)
		return false;
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
		if (!Number.isFinite(value[key])) return false;
	}
	for (const key of ["cacheWrite1h", "reasoning"] as const) {
		if (value[key] !== undefined && !Number.isFinite(value[key])) return false;
	}
	const cost = value.cost;
	if (!isRecord(cost) || !hasOnlyKeys(cost, ["input", "output", "cacheRead", "cacheWrite", "total"])) return false;
	return ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => Number.isFinite(cost[key]));
}

function isProjection(value: unknown): value is PortableCompactionProjection {
	if (!isRecord(value) || !hasOnlyKeys(value, ["type", "version", "customType", "summary", "details", "usage"]))
		return false;
	return (
		value.type === "portable_compaction_projection" &&
		value.version === 1 &&
		typeof value.customType === "string" &&
		value.customType.trim().length > 0 &&
		typeof value.summary === "string" &&
		value.summary.trim().length > 0 &&
		(value.details === undefined || isJsonValue(value.details)) &&
		(value.usage === undefined || isUsage(value.usage))
	);
}

function isCheckpoint(value: unknown): value is ProviderCheckpoint {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"type",
			"version",
			"identity",
			"payload",
			"usage",
			"frontierEntryId",
			"predecessorEntryId",
			"windowGeneration",
			"metadata",
		])
	)
		return false;
	const identity = value.identity;
	const payload = value.payload;
	if (!isRecord(identity) || !hasOnlyKeys(identity, ["adapter", "realm", "provider", "endpoint", "modelFamily"]))
		return false;
	if (
		identity.adapter !== OPENAI_RESPONSES_COMPACTION_ADAPTER ||
		![identity.realm, identity.provider, identity.endpoint, identity.modelFamily].every(
			(part) => typeof part === "string" && part.trim().length > 0,
		)
	)
		return false;
	if (!isRecord(payload) || !hasOnlyKeys(payload, ["id", "created_at", "object", "output", "usage"])) return false;
	const payloadUsage = payload.usage;
	if (
		!isRecord(payloadUsage) ||
		!hasOnlyKeys(payloadUsage, [
			"input_tokens",
			"input_tokens_details",
			"output_tokens",
			"output_tokens_details",
			"total_tokens",
		])
	)
		return false;
	if (![payloadUsage.input_tokens, payloadUsage.output_tokens, payloadUsage.total_tokens].every(Number.isFinite))
		return false;
	if (
		!isRecord(payloadUsage.input_tokens_details) ||
		!Number.isFinite(payloadUsage.input_tokens_details.cached_tokens)
	)
		return false;
	if (
		!isRecord(payloadUsage.output_tokens_details) ||
		!Number.isFinite(payloadUsage.output_tokens_details.reasoning_tokens)
	)
		return false;
	return (
		value.type === "provider_checkpoint" &&
		value.version === 1 &&
		typeof value.frontierEntryId === "string" &&
		value.frontierEntryId.length > 0 &&
		(value.predecessorEntryId === undefined ||
			(typeof value.predecessorEntryId === "string" && value.predecessorEntryId.length > 0)) &&
		Number.isSafeInteger(value.windowGeneration) &&
		(value.windowGeneration as number) >= 1 &&
		(value.metadata === undefined || (isRecord(value.metadata) && isJsonValue(value.metadata))) &&
		(value.usage === undefined || isUsage(value.usage)) &&
		typeof payload.id === "string" &&
		Number.isFinite(payload.created_at) &&
		payload.object === "response.compaction" &&
		Array.isArray(payload.output) &&
		isJsonValue(payload.output)
	);
}

/** Strict decoder for untrusted JSON-loaded compaction boundary rows. */
export function decodeStoredCompactionBoundaryEntry(value: unknown): StoredCompactionBoundaryEntry | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["type", "id", "parentId", "timestamp", "boundary"])) return undefined;
	if (
		value.type !== "compaction_boundary" ||
		typeof value.id !== "string" ||
		value.id.length === 0 ||
		(value.parentId !== null && typeof value.parentId !== "string") ||
		typeof value.timestamp !== "string" ||
		value.timestamp.length === 0
	)
		return undefined;
	const boundary = value.boundary;
	if (!isRecord(boundary) || !hasOnlyKeys(boundary, ["version", "tokensBefore", "primary", "projections"]))
		return undefined;
	if (boundary.version !== 1 || !Number.isFinite(boundary.tokensBefore) || (boundary.tokensBefore as number) < 0)
		return undefined;
	if (!Array.isArray(boundary.projections) || !boundary.projections.every(isProjection)) return undefined;
	const primary = boundary.primary;
	if (!isRecord(primary)) return undefined;
	if (primary.kind === "text") {
		if (!hasOnlyKeys(primary, ["kind", "summary", "firstKeptEntryId", "details", "fromExtension", "usage"]))
			return undefined;
		if (
			typeof primary.summary !== "string" ||
			primary.summary.trim().length === 0 ||
			typeof primary.firstKeptEntryId !== "string" ||
			primary.firstKeptEntryId.length === 0 ||
			typeof primary.fromExtension !== "boolean" ||
			(primary.details !== undefined && !isJsonValue(primary.details)) ||
			(primary.usage !== undefined && !isUsage(primary.usage))
		)
			return undefined;
	} else if (primary.kind === "checkpoint") {
		if (!hasOnlyKeys(primary, ["kind", "checkpoint", "usage"]) || !isCheckpoint(primary.checkpoint)) return undefined;
		if (primary.usage !== undefined && !isUsage(primary.usage)) return undefined;
	} else return undefined;
	return value as unknown as StoredCompactionBoundaryEntry;
}

export function isStoredCompactionBoundaryEntry(value: unknown): value is StoredCompactionBoundaryEntry {
	return decodeStoredCompactionBoundaryEntry(value) !== undefined;
}

function addUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
	if (!left) return right ? structuredClone(right) : undefined;
	if (!right) return structuredClone(left);
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined
			? { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }
			: {}),
		...(left.reasoning !== undefined || right.reasoning !== undefined
			? { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }
			: {}),
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

function combinedBoundaryUsage(entry: StoredCompactionBoundaryEntry): Usage | undefined {
	let usage = entry.boundary.primary.usage;
	for (const projection of entry.boundary.projections) usage = addUsage(usage, projection.usage);
	return usage;
}

export function toCompactionBoundary(
	entry: StoredCompactionBoundaryEntry | ProviderCheckpointEntry,
): CompactionBoundaryEntry {
	if (entry.type === "provider_checkpoint") return adaptProviderCheckpoint(entry);
	const decoded = decodeStoredCompactionBoundaryEntry(entry);
	if (!decoded) throw new Error("Invalid compaction boundary");
	const primary = decoded.boundary.primary;
	const usage = combinedBoundaryUsage(decoded);
	return {
		type: "compaction_boundary",
		id: decoded.id,
		parentId: decoded.parentId,
		timestamp: decoded.timestamp,
		boundary: {
			id: decoded.id,
			parentId: decoded.parentId,
			timestamp: decoded.timestamp,
			version: 1,
			kind: primary.kind,
			tokensBefore: decoded.boundary.tokensBefore,
			...(primary.kind === "text"
				? {
						text: {
							summary: primary.summary,
							firstKeptEntryId: primary.firstKeptEntryId,
							...(primary.details !== undefined ? { details: structuredClone(primary.details) } : {}),
							fromExtension: primary.fromExtension,
						},
					}
				: {}),
			projections: structuredClone(decoded.boundary.projections),
			...(usage ? { usage } : {}),
		},
	};
}

function adaptCompaction(entry: CompactionEntry): CompactionBoundaryEntry {
	return {
		type: "compaction_boundary",
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		boundary: {
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			version: 1,
			kind: "text",
			tokensBefore: entry.tokensBefore,
			text: {
				summary: entry.summary,
				firstKeptEntryId: entry.firstKeptEntryId,
				...(entry.details !== undefined ? { details: structuredClone(entry.details) } : {}),
				fromExtension: entry.fromHook === true,
			},
			projections: [],
			...(entry.usage ? { usage: structuredClone(entry.usage) } : {}),
		},
	};
}

function adaptProviderCheckpoint(entry: ProviderCheckpointEntry): CompactionBoundaryEntry {
	return {
		type: "compaction_boundary",
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		boundary: {
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			version: 1,
			kind: "checkpoint",
			tokensBefore: entry.checkpoint.payload.usage.total_tokens,
			projections: [],
		},
	};
}

export function readCompactionBoundaries(path: string): CompactionBoundaryEntry[] {
	if (!existsSync(path)) return [];
	const entries: SessionEntryBase[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (
			!isRecord(value) ||
			value.type === "session" ||
			typeof value.type !== "string" ||
			typeof value.id !== "string" ||
			(value.parentId !== null && typeof value.parentId !== "string") ||
			typeof value.timestamp !== "string"
		)
			continue;
		entries.push(value as unknown as SessionEntryBase);
	}
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	let leaf = entries.at(-1);
	const ancestry: SessionEntryBase[] = [];
	while (leaf) {
		ancestry.push(leaf);
		leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
	}
	ancestry.reverse();
	const boundaries: CompactionBoundaryEntry[] = [];
	for (const entry of ancestry) {
		if (entry.type === "compaction") boundaries.push(adaptCompaction(entry as CompactionEntry));
		else if (entry.type === "provider_checkpoint") {
			const checkpointEntry = entry as ProviderCheckpointEntry;
			if (isCheckpoint(checkpointEntry.checkpoint)) boundaries.push(adaptProviderCheckpoint(checkpointEntry));
		} else {
			const decoded = decodeStoredCompactionBoundaryEntry(entry);
			if (decoded) boundaries.push(toCompactionBoundary(decoded));
		}
	}
	return boundaries;
}
