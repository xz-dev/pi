import { uuidv7 } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "./types.ts";

const MAX_WAIT_SECONDS = 1800;

const managedExecutionReplays = new WeakMap<object, boolean>();

export type BackgroundToolCallRule = {
	detachAfterSeconds?: number;
	shouldDetach?: (argumentsValue: unknown) => boolean;
};

export type BackgroundToolCalls = Record<string, BackgroundToolCallRule>;

export type ManagedExecutionStatus = "running" | "completed" | "error" | "cancel_requested";

export type ManagedExecutionCancelDisposition = "requested" | "already_requested" | "already_terminal";

export interface ManagedExecutionCancelResult {
	disposition: ManagedExecutionCancelDisposition;
	status: ManagedExecutionStatus;
}

export type ManagedExecutionOutcome = AgentToolResult<unknown> & {
	isError: boolean;
};

export function createManagedExecutionOutcome(
	result: AgentToolResult<unknown>,
	isError: boolean,
): ManagedExecutionOutcome {
	return { ...result, isError };
}

export function createManagedExecutionReplay(outcome: ManagedExecutionOutcome): AgentToolResult<unknown> {
	const { isError, ...result } = outcome;
	managedExecutionReplays.set(result, isError);
	return result;
}

export function getManagedExecutionReplayError(result: AgentToolResult<unknown>): boolean | undefined {
	return managedExecutionReplays.get(result);
}

export interface ManagedExecutionInfo {
	id: string;
	toolCallId: string;
	toolName: string;
	startedAt: number;
	detachedAt: number;
	completedAt?: number;
	status: ManagedExecutionStatus;
	cancelRequestedAt?: number;
}

export interface ManagedExecutionRegistration {
	toolCallId: string;
	toolName: string;
	arguments: unknown;
	startedAt: number;
	controller: AbortController;
	completion: Promise<ManagedExecutionOutcome>;
}

export interface ManagedExecutionNotification {
	id: string;
	toolCallId: string;
	toolName: string;
	status: "completed" | "error";
}

type ManagedExecutionRecord = ManagedExecutionInfo & {
	arguments: unknown;
	controller: AbortController;
	completion: Promise<ManagedExecutionOutcome>;
	outcome?: ManagedExecutionOutcome;
};

export class ManagedExecutionRegistry {
	private readonly records = new Map<string, ManagedExecutionRecord>();
	private onCompletion?: (notification: ManagedExecutionNotification) => void | Promise<void>;
	private notificationsEnabled = true;

	setCompletionHandler(
		handler: ((notification: ManagedExecutionNotification) => void | Promise<void>) | undefined,
	): void {
		this.onCompletion = handler;
	}

	register(registration: ManagedExecutionRegistration): string {
		const id = uuidv7();
		const detachedAt = Date.now();
		const record: ManagedExecutionRecord = {
			id,
			toolCallId: registration.toolCallId,
			toolName: registration.toolName,
			arguments: registration.arguments,
			startedAt: registration.startedAt,
			detachedAt,
			status: "running",
			controller: registration.controller,
			completion: registration.completion,
		};
		this.records.set(id, record);
		void registration.completion.then((outcome) => {
			if (this.records.get(id) !== record) return;
			record.outcome = outcome;
			record.completedAt = Date.now();
			record.status = outcome.isError ? "error" : "completed";
			if (!this.notificationsEnabled || !this.onCompletion) return;
			void Promise.resolve(
				this.onCompletion({
					id,
					toolCallId: record.toolCallId,
					toolName: record.toolName,
					status: record.status,
				}),
			).catch(() => {});
		});
		return id;
	}

	list(): ManagedExecutionInfo[] {
		return [...this.records.values()].map((record) => this.toInfo(record));
	}

	info(id: string): ManagedExecutionInfo | undefined {
		const record = this.records.get(id);
		return record ? this.toInfo(record) : undefined;
	}

	async wait(id: string, timeoutSeconds: number): Promise<ManagedExecutionOutcome> {
		if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > MAX_WAIT_SECONDS) {
			throw new Error(`timeoutSeconds must be a positive finite number no greater than ${MAX_WAIT_SECONDS}`);
		}
		const record = this.require(id);
		if (record.outcome) return record.outcome;

		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				record.completion,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(
						() =>
							reject(
								new Error(`Managed tool execution ${id} did not complete within ${timeoutSeconds} seconds`),
							),
						timeoutSeconds * 1000,
					);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	cancel(id: string): ManagedExecutionCancelResult {
		const record = this.require(id);
		if (record.outcome) return { disposition: "already_terminal", status: record.status };
		if (record.status === "cancel_requested") {
			return { disposition: "already_requested", status: record.status };
		}
		record.status = "cancel_requested";
		record.cancelRequestedAt = Date.now();
		record.controller.abort();
		return { disposition: "requested", status: record.status };
	}

	clear(): void {
		for (const record of this.records.values()) {
			if (!record.outcome) record.controller.abort();
		}
		this.records.clear();
	}

	dispose(): void {
		this.notificationsEnabled = false;
		this.onCompletion = undefined;
		this.clear();
	}

	private require(id: string): ManagedExecutionRecord {
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown managed tool execution: ${id}`);
		return record;
	}

	private toInfo(record: ManagedExecutionRecord): ManagedExecutionInfo {
		return {
			id: record.id,
			toolCallId: record.toolCallId,
			toolName: record.toolName,
			startedAt: record.startedAt,
			detachedAt: record.detachedAt,
			completedAt: record.completedAt,
			status: record.status,
			cancelRequestedAt: record.cancelRequestedAt,
		};
	}
}
