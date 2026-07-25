import { existsSync, readFileSync } from "node:fs";
import type { Usage } from "@earendil-works/pi-ai";
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
	const primary = entry.boundary.primary;
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
			kind: primary.kind,
			tokensBefore: entry.boundary.tokensBefore,
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
			projections: structuredClone(entry.boundary.projections),
			...(combinedBoundaryUsage(entry) ? { usage: combinedBoundaryUsage(entry) } : {}),
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

export function isStoredCompactionBoundaryEntry(value: unknown): value is StoredCompactionBoundaryEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Partial<StoredCompactionBoundaryEntry>;
	if (
		entry.type !== "compaction_boundary" ||
		typeof entry.id !== "string" ||
		(entry.parentId !== null && typeof entry.parentId !== "string") ||
		typeof entry.timestamp !== "string" ||
		!entry.boundary ||
		typeof entry.boundary !== "object" ||
		entry.boundary.version !== 1 ||
		!Number.isFinite(entry.boundary.tokensBefore) ||
		!Array.isArray(entry.boundary.projections) ||
		!entry.boundary.primary ||
		typeof entry.boundary.primary !== "object"
	) {
		return false;
	}
	const primary = entry.boundary.primary;
	return primary.kind === "text" || primary.kind === "checkpoint";
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
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const entry = value as Partial<SessionEntryBase>;
		if (
			entry.type === "session" ||
			typeof entry.type !== "string" ||
			typeof entry.id !== "string" ||
			(entry.parentId !== null && typeof entry.parentId !== "string") ||
			typeof entry.timestamp !== "string"
		) {
			continue;
		}
		entries.push(entry as SessionEntryBase);
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
			boundaries.push(toCompactionBoundary(entry as ProviderCheckpointEntry));
		} else if (isStoredCompactionBoundaryEntry(entry)) {
			boundaries.push(toCompactionBoundary(entry));
		}
	}
	return boundaries;
}
