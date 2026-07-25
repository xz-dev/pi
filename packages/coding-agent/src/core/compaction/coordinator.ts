import type { OpenAIResponsesCheckpointIdentity, Usage } from "@earendil-works/pi-ai";
import type { ExtensionRunner } from "../extensions/runner.ts";
import type { ProviderCheckpoint, SessionEntry, SessionManager } from "../session-manager.ts";
import {
	type CompactionBoundary,
	type CompactionBoundaryDraft,
	type CompactionOutcome,
	type PortableCompactionProjection,
	toCompactionBoundary,
} from "./boundary.ts";
import type { CompactionPreparation, LegacyCompactionResult } from "./compaction.ts";

export type CompactionReason = "manual" | "threshold" | "overflow";

export type CompactionPrimaryDraft = CompactionBoundaryDraft["primary"];

export interface CompactionExecutionContext {
	reason: CompactionReason;
	willRetry: boolean;
	customInstructions?: string;
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	signal: AbortSignal;
}

export interface CoordinateCompactionOptions extends CompactionExecutionContext {
	sessionManager: SessionManager;
	extensionRunner: ExtensionRunner;
	checkpointIdentity?: OpenAIResponsesCheckpointIdentity;
	getCurrentCheckpointIdentity?(): OpenAIResponsesCheckpointIdentity | undefined;
	executeText(replacement: LegacyCompactionResult | undefined): Promise<CompactionPrimaryDraft>;
	executeCheckpoint(): Promise<CompactionPrimaryDraft>;
	rebuild(identity: OpenAIResponsesCheckpointIdentity | undefined): number;
	emitCompact(boundary: CompactionBoundary, outcome: CompactionOutcome): Promise<void>;
	emitEnd(outcome: CompactionOutcome): void;
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

function aggregateUsage(
	primary: CompactionPrimaryDraft,
	projections: PortableCompactionProjection[],
): Usage | undefined {
	let usage = primary.usage;
	for (const projection of projections) usage = addUsage(usage, projection.usage);
	return usage;
}

export async function coordinateCompaction(options: CoordinateCompactionOptions): Promise<CompactionOutcome> {
	const expected = options.sessionManager.captureCompactionBoundaryAppendState();
	const aggregate = await options.extensionRunner.emitSessionBeforeCompact({
		type: "session_before_compact",
		preparation: options.preparation,
		branchEntries: options.branchEntries,
		customInstructions: options.customInstructions,
		reason: options.reason,
		willRetry: options.willRetry,
		signal: options.signal,
	});
	if (aggregate.cancel || options.signal.aborted) throw new DOMException("Compaction cancelled", "AbortError");

	const primary = aggregate.replacement
		? await options.executeText(aggregate.replacement)
		: options.checkpointIdentity
			? await options.executeCheckpoint()
			: await options.executeText(undefined);
	if (options.signal.aborted) throw new DOMException("Compaction cancelled", "AbortError");

	const boundaryEntryId = options.sessionManager.appendCompactionBoundary(
		{
			version: 1,
			tokensBefore: options.preparation.tokensBefore,
			primary,
			projections: aggregate.projections,
		},
		{
			expected,
			...(options.checkpointIdentity ? { currentCheckpointIdentity: options.getCurrentCheckpointIdentity?.() } : {}),
		},
	);
	const entry = options.sessionManager.getEntry(boundaryEntryId);
	if (entry?.type !== "compaction_boundary") throw new Error("Compaction boundary append did not create a boundary");

	const estimatedTokensAfter = options.rebuild(options.checkpointIdentity);
	const boundary = toCompactionBoundary(entry).boundary;
	const usage = aggregateUsage(primary, aggregate.projections);
	const base = {
		boundaryEntryId,
		tokensBefore: options.preparation.tokensBefore,
		estimatedTokensAfter,
		...(usage ? { usage } : {}),
		projectionCount: aggregate.projections.length,
	};
	const outcome: CompactionOutcome =
		primary.kind === "text"
			? {
					kind: "text",
					...base,
					summary: primary.summary,
					firstKeptEntryId: primary.firstKeptEntryId,
					...(primary.details !== undefined ? { details: primary.details } : {}),
					fromExtension: primary.fromExtension,
				}
			: { kind: "checkpoint", ...base };
	await options.emitCompact(boundary, outcome);
	options.emitEnd(outcome);
	return outcome;
}

export type CheckpointPrimaryDraft = Extract<CompactionPrimaryDraft, { kind: "checkpoint" }> & {
	checkpoint: ProviderCheckpoint;
};
