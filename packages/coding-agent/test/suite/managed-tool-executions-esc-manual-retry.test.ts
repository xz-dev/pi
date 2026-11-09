import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Message, type ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

// CI-owned narrow structural view of the managed-executions surface; the ci
// branch does not export the registry types, so these interfaces deliberately
// avoid `any` while staying compilable against both stacks.
type ManagedExecutionStatus = "running" | "completed" | "error" | "cancel_requested";

type ManagedExecutionInfo = {
	id: string;
	toolName: string;
	toolCallId: string;
	status: ManagedExecutionStatus;
};

type ManagedWaitResult = {
	content: Array<{ type: string; text?: string }>;
	details: unknown;
	isError: boolean;
};

type ManagedExecutionCancelResult = {
	disposition: "requested" | "already_requested" | "already_terminal";
	status: ManagedExecutionStatus;
};

type ManagedExecutionsApi = {
	list(): ManagedExecutionInfo[];
	wait(id: string, timeoutSeconds: number): Promise<ManagedWaitResult>;
	cancel(id: string): ManagedExecutionCancelResult;
};

function managedFromSession(session: Harness["session"]): ManagedExecutionsApi {
	const agent = session.agent as typeof session.agent & { managedExecutions?: ManagedExecutionsApi };
	expect(agent.managedExecutions, "Agent.managedExecutions public registry").toBeDefined();
	return agent.managedExecutions!;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> } | undefined): string {
	return (
		result?.content
			?.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n") ?? ""
	);
}

function messageText(message: AgentMessage | Message): string {
	const content = (message as { content?: Array<{ type: string; text?: string }> }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function toolResultsFor(harness: Harness, toolCallId: string): ToolResultMessage[] {
	return harness.session.messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === toolCallId,
	);
}

function persistedMessages(harness: Harness): AgentMessage[] {
	return harness.sessionManager.getEntries().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

function persistedToolResultsFor(harness: Harness, toolCallId: string): ToolResultMessage[] {
	return persistedMessages(harness).filter(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === toolCallId,
	);
}

function persistedAssistants(harness: Harness) {
	return persistedMessages(harness).filter((message) => message.role === "assistant");
}

function createDeferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

const emptySchema = Type.Object({});

// Detachable tool that records its own signal state and waits on an explicit
// release barrier instead of racing a fixed timer.
type BarrierTool = {
	tool: AgentTool;
	started: ReturnType<typeof createDeferred<void>>;
	release: ReturnType<typeof createDeferred<string>>;
	aborted: () => boolean;
	abortSeen: () => boolean;
};

function barrierTool(name: string): BarrierTool {
	const started = createDeferred<void>();
	const release = createDeferred<string>();
	const state: { signal?: AbortSignal; abortSeen: boolean } = { abortSeen: false };
	const tool: AgentTool = {
		name,
		label: name,
		description: `${name} waits on an explicit release barrier`,
		parameters: emptySchema,
		execute: async (_toolCallId, _params, signal) => {
			state.signal = signal;
			started.resolve(undefined);
			signal?.addEventListener("abort", () => {
				state.abortSeen = true;
			});
			const text = await release.promise;
			return { content: [{ type: "text", text }], details: { text } };
		},
	};
	return { tool, started, release, aborted: () => state.signal?.aborted === true, abortSeen: () => state.abortSeen };
}

// A non-cooperative tool records abort but does not settle until explicitly
// released. Esc must release the run without waiting for this late result.
type BlockingTool = {
	tool: AgentTool;
	started: ReturnType<typeof createDeferred<void>>;
	release: ReturnType<typeof createDeferred<void>>;
	completed: ReturnType<typeof createDeferred<void>>;
	abortSeen: () => boolean;
};

function blockingTool(name: string): BlockingTool {
	const started = createDeferred<void>();
	const release = createDeferred<void>();
	const completed = createDeferred<void>();
	const state = { abortSeen: false };
	const tool: AgentTool = {
		name,
		label: name,
		description: `${name} stays blocked until released even after abort`,
		parameters: emptySchema,
		execute: (_toolCallId, _params, signal) => {
			signal?.addEventListener(
				"abort",
				() => {
					state.abortSeen = true;
				},
				{ once: true },
			);
			started.resolve(undefined);
			const completion = release.promise.then(() => ({
				content: [{ type: "text" as const, text: "late blocking result" }],
				details: {},
			}));
			void completion.then(() => completed.resolve(undefined));
			return completion;
		},
	};
	return { tool, started, release, completed, abortSeen: () => state.abortSeen };
}

describe("managed detach + Esc + manual /retry seam", () => {
	const harnesses: Harness[] = [];
	const releases: Array<() => void> = [];

	afterEach(() => {
		while (releases.length > 0) releases.pop()?.();
		vi.useRealTimers();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function detachedHarness(
		detached: BarrierTool,
		blocking: BlockingTool,
	): Promise<{ harness: Harness; prompt: Promise<void> }> {
		vi.useFakeTimers();
		const options = {
			tools: [detached.tool, blocking.tool],
			settings: {
				backgroundToolCalls: { detach: { detachAfterSeconds: 1 } },
				retry: { enabled: false },
			},
		};
		const harness = await createHarness(options);
		harnesses.push(harness);
		releases.push(() => detached.release.resolve("cleanup"));
		releases.push(() => blocking.release.resolve(undefined));
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("detach", {}, { id: "call-detach" }), fauxToolCall("blocking", {}, { id: "call-blocking" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("unreachable while blocking stays blocked"),
		]);
		const prompt = harness.session.prompt("run detach and blocking");
		await detached.started.promise;
		await blocking.started.promise;
		// Fire the detach timer while the foreground tool still blocks so the same
		// run stays active and owns a real registry entry.
		await vi.advanceTimersByTimeAsync(1000);
		return { harness, prompt };
	}

	it("keeps the detached tool running through Esc and completes once in session and storage", async () => {
		const detached = barrierTool("detach");
		const blocking = blockingTool("blocking");
		const { harness, prompt } = await detachedHarness(detached, blocking);

		const managed = managedFromSession(harness.session);
		const [task] = managed.list();
		expect(task?.toolCallId).toBe("call-detach");
		expect(task?.status).toBe("running");

		// Real Esc: abort the whole run, not the detached tool, then let it settle.
		await harness.session.abort();
		await prompt;

		expect(blocking.abortSeen()).toBe(true);
		expect(detached.abortSeen()).toBe(false);
		expect(detached.aborted()).toBe(false);
		expect(managed.list()[0]?.status).toBe("running");

		// Releasing detached work resolves through the registry's own wait() and
		// leaves exactly one original tool-result in memory and in stored entries.
		detached.release.resolve("detached-result");
		const outcome = await managed.wait(task!.id, 1);
		expect(outcome.isError).toBe(false);
		expect(detached.aborted()).toBe(false);
		expect(textOf(outcome)).toContain("detached-result");
		expect(managed.list()[0]?.status).toBe("completed");

		const results = toolResultsFor(harness, "call-detach");
		expect(results).toHaveLength(1);
		expect(textOf(results[0])).toContain("continues in background");
		expect(persistedToolResultsFor(harness, "call-detach")).toHaveLength(1);
	});

	it("cancelling a detached tool aborts its signal without duplicating persisted results", async () => {
		const detached = barrierTool("detach");
		const blocking = blockingTool("blocking");
		const { harness, prompt } = await detachedHarness(detached, blocking);

		const managed = managedFromSession(harness.session);
		const [task] = managed.list();
		expect(task?.status).toBe("running");

		// Registry-owned cancel after detach must reach the tool's own signal.
		expect(managed.cancel(task!.id)).toEqual({ disposition: "requested", status: "cancel_requested" });
		expect(detached.abortSeen()).toBe(true);
		expect(detached.aborted()).toBe(true);
		expect(blocking.abortSeen()).toBe(false);

		await harness.session.abort();
		await prompt;
		detached.release.resolve("detached-after-cancel");

		const outcome = await managed.wait(task!.id, 1);
		expect(detached.abortSeen()).toBe(true);
		expect(detached.aborted()).toBe(true);
		expect(managed.list()[0]?.status).toBe("completed");
		expect(outcome.isError).toBe(false);
		expect(textOf(outcome)).toContain("detached-after-cancel");

		expect(toolResultsFor(harness, "call-detach")).toHaveLength(1);
		expect(persistedToolResultsFor(harness, "call-detach")).toHaveLength(1);
	});

	it("Esc on a blocked tool seeds /retry recovery that publishes exactly once", async () => {
		const blocking = blockingTool("blocking");
		const options = {
			tools: [blocking.tool],
			settings: { retry: { enabled: false } },
			sessionManagerFactory: (tempDir: string) => SessionManager.create(tempDir, tempDir),
		};
		const harness = await createHarness(options);
		harnesses.push(harness);
		releases.push(() => blocking.release.resolve(undefined));

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("blocking", {}, { id: "call-block" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("unreachable while blocking stays blocked"),
		]);
		const prompt = harness.session.prompt("run blocking");
		await blocking.started.promise;

		// Real Esc while the non-detached tool is still blocked.
		await harness.session.abort();
		await prompt;
		expect(blocking.abortSeen()).toBe(true);
		expect(managedFromSession(harness.session).list()).toEqual([]);

		const entriesAfterAbort = harness.sessionManager.getEntries().length;
		const assistantsAfterAbort = persistedAssistants(harness).length;

		// Retry must retain the aborted tool result and provider-only recovery cue,
		// then publish exactly one recovery assistant in memory and on disk.
		let requestMessages: Message[] = [];
		harness.setResponses([
			(context) => {
				requestMessages = context.messages;
				return fauxAssistantMessage("recovered once");
			},
		]);
		await (harness.session as typeof harness.session & { retry(): Promise<void> }).retry();

		const synthetic = requestMessages.find(
			(message): message is ToolResultMessage =>
				message.role === "toolResult" && message.toolCallId === "call-block",
		);
		// Esc abort persisted an error toolResult for the interrupted call. /retry
		// must not replay the tool, so the provider context still carries exactly
		// that one result marked isError, and no duplicate synthetic result.
		expect(synthetic?.isError).toBe(true);
		expect(
			requestMessages.filter((message) => message.role === "toolResult" && message.toolCallId === "call-block"),
		).toHaveLength(1);
		expect(
			requestMessages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((part) => part.type === "toolCall" && part.id === "call-block"),
			),
		).toBe(true);
		expect(
			requestMessages.some(
				(message) =>
					message.role === "user" && messageText(message).includes("previous assistant response was interrupted"),
			),
		).toBe(true);

		expect(
			harness.session.messages.filter(
				(message) => message.role === "assistant" && messageText(message) === "recovered once",
			),
		).toHaveLength(1);
		expect(persistedAssistants(harness).filter((message) => messageText(message) === "recovered once")).toHaveLength(
			1,
		);
		expect(persistedAssistants(harness).length).toBe(assistantsAfterAbort + 1);
		// The cue is provider-only; recovery must add one assistant, not a second
		// persisted tool result or a transcript entry for the temporary cue.
		expect(harness.sessionManager.getEntries().length).toBe(entriesAfterAbort + 1);
		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const persistedAfterRetry = SessionManager.open(sessionFile!).getEntries();
		expect(persistedAfterRetry).toEqual(harness.sessionManager.getEntries());

		// The abort-produced error result stays the single persisted record for
		// the call; releasing the interrupted tool afterwards must not append a
		// second result or overwrite the recovery branch.
		blocking.release.resolve(undefined);
		await blocking.completed.promise;
		await Promise.resolve();
		expect(SessionManager.open(sessionFile!).getEntries()).toEqual(persistedAfterRetry);
		expect(toolResultsFor(harness, "call-block")).toHaveLength(1);
		expect(persistedToolResultsFor(harness, "call-block")).toHaveLength(1);
		expect(persistedAssistants(harness).filter((message) => messageText(message) === "recovered once")).toHaveLength(
			1,
		);
	});
});
