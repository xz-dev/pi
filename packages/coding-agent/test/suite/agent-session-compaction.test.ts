import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type Provider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/index.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function useSummaryStreamFn(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.session.agent.streamFunction = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function seedCompactableSession(
	harness: Harness,
	options?: { userText?: string; assistantText?: string; timestamp?: number },
): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = options?.timestamp ?? Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: options?.userText ?? "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: options?.assistantText ?? "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function createUiContext(
	onNotify: (message: string, type: "info" | "warning" | "error" | undefined) => void,
): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: onNotify,
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			throw new Error("theme not available in tests");
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	} as unknown as ExtensionUIContext;
}

function configureRemoteOpenAIModel(
	harness: Harness,
	options?: { baseUrl?: string; id?: string; provider?: string },
): Model<"openai-responses"> {
	const model = {
		...harness.getModel(),
		api: "openai-responses" as const,
		provider: options?.provider ?? "openai",
		baseUrl: options?.baseUrl ?? "https://api.openai.com/v1",
		id: options?.id ?? "gpt-5.4",
	};
	harness.session.agent.state.model = model;
	harness.session.modelRuntime.registerNativeProvider({
		id: model.provider,
		name: "OpenAI",
		auth: {
			apiKey: {
				name: "OpenAI API key",
				resolve: async () => ({ auth: { apiKey: "test-key" }, source: "test" }),
			},
		},
		getModels: () => [model],
		stream: () => createAssistantMessageEventStream(),
		streamSimple: () => createAssistantMessageEventStream(),
	});
	return model;
}

function configureRemoteCodexModel(harness: Harness): Model<"openai-codex-responses"> {
	const model = {
		...harness.getModel(),
		api: "openai-codex-responses" as const,
		provider: "openai-codex",
		baseUrl: "https://codex.example/backend-api",
		id: "gpt-5.4",
	};
	const token = `x.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }))}.x`;
	harness.session.agent.state.model = model;
	harness.session.modelRuntime.registerNativeProvider({
		id: model.provider,
		name: "OpenAI Codex",
		auth: {
			apiKey: {
				name: "Codex token",
				resolve: async () => ({ auth: { apiKey: token }, source: "test" }),
			},
		},
		getModels: () => [model],
		stream: () => createAssistantMessageEventStream(),
		streamSimple: () => createAssistantMessageEventStream(),
	});
	return model;
}

function remoteCompactOutput(marker = "opaque") {
	return [
		{ role: "user", content: [{ type: "input_text", text: "retained" }] },
		{ type: "compaction", id: "cmp_1", encrypted_content: marker },
	];
}

function mockRemoteCompactHttp(options: {
	success?: boolean;
	output?: unknown[];
	status?: number;
	body?: string;
	onRequest?: (url: string, init?: RequestInit) => void;
	waitForAbort?: boolean;
	throwAbortError?: boolean;
}): { requests: Array<{ url: string; body: string }> } {
	const requests: Array<{ url: string; body: string }> = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const body = String(init?.body ?? "");
		requests.push({ url, body });
		options.onRequest?.(url, init);
		if (options.throwAbortError) {
			const error = new Error("remote aborted");
			error.name = "AbortError";
			throw error;
		}
		if (options.waitForAbort) {
			await new Promise<void>((_resolve, reject) => {
				if (init?.signal?.aborted) {
					reject(init.signal.reason ?? new DOMException("aborted", "AbortError"));
					return;
				}
				init?.signal?.addEventListener(
					"abort",
					() => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")),
					{ once: true },
				);
			});
		}
		if (options.success === false) {
			return new Response(options.body ?? "remote compact failed: provider rejected", {
				status: options.status ?? 500,
				headers: { "content-type": "text/plain" },
			});
		}
		return new Response(
			JSON.stringify({
				id: "resp_compact_1",
				created_at: 1,
				object: "response.compaction",
				output: options.output ?? remoteCompactOutput(),
				usage: {
					input_tokens: 12,
					input_tokens_details: { cached_tokens: 2 },
					output_tokens: 3,
					output_tokens_details: { reasoning_tokens: 1 },
					total_tokens: 15,
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	});
	return { requests };
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	return haystack.split(needle).length - 1;
}

function seedProductionSession(
	sessionManager: SessionManager,
	model: Model<"openai-responses">,
	userText: string,
	assistantText: string,
	timestamp = Date.now(),
): void {
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: userText }],
		timestamp: timestamp - 1000,
	});
	sessionManager.appendMessage({
		...fauxAssistantMessage(assistantText, { timestamp: timestamp - 500 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(100),
	});
}

async function createProductionRemoteSession(options?: { sessionManager?: SessionManager }) {
	const model: Model<"openai-responses"> = {
		id: "current-model",
		name: "Current model",
		api: "openai-responses",
		provider: "current-provider",
		baseUrl: "https://current.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_000,
	};
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "runtime-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	const classicRequests: Array<{ context: unknown; options?: SimpleStreamOptions; payload?: unknown }> = [];
	const afterProviderResponses: Array<{ status: number; headers: Record<string, string> }> = [];
	const compactEvents: Array<{
		id: string;
		details?: unknown;
		usage?: ReturnType<typeof createUsage>;
	}> = [];
	const provider: Provider = {
		id: model.provider,
		name: "Current provider",
		auth: {
			apiKey: {
				name: "Current provider key",
				check: async ({ credential }) => (credential?.key ? { type: "api_key", source: "test" } : undefined),
				resolve: async ({ credential }) =>
					credential?.key
						? {
								auth: {
									apiKey: credential.key,
									baseUrl: model.baseUrl,
									headers: { "x-runtime-auth": "resolved" },
								},
								env: { RUNTIME_ENV: "resolved" },
								source: "test",
							}
						: undefined,
			},
		},
		getModels: () => [model],
		stream: () => createAssistantMessageEventStream(),
		streamSimple: (requestModel, context, requestOptions) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				void (async () => {
					const basePayload = { kind: "classic-summary", messages: context.messages };
					const nextPayload = requestOptions?.onPayload
						? await requestOptions.onPayload(basePayload, requestModel)
						: basePayload;
					const payload = nextPayload === undefined ? basePayload : nextPayload;
					classicRequests.push({ context, options: requestOptions, payload });
					if (requestOptions?.onResponse) {
						await requestOptions.onResponse({ status: 200, headers: { "x-classic": "1" } }, requestModel);
					}
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							...fauxAssistantMessage("production classic summary"),
							api: requestModel.api,
							provider: requestModel.provider,
							model: requestModel.id,
							usage: createUsage(10),
						},
					});
				})();
			});
			return stream;
		},
	};
	modelRuntime.registerNativeProvider(provider);
	const sessionManager = options?.sessionManager ?? SessionManager.inMemory();
	const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } });
	const extensionsResult = await createTestExtensionsResult([
		(pi) => {
			pi.on("session_compact", (event) => {
				compactEvents.push({
					id: event.compactionEntry.id,
					details: event.compactionEntry.details,
					usage: event.compactionEntry.usage,
				});
			});
			pi.on("before_provider_request", (event) => {
				if (event.payload && typeof event.payload === "object") {
					return {
						...(event.payload as Record<string, unknown>),
						classicRecoveryMarker: "from-before-provider-request",
					};
				}
				return {
					original: event.payload,
					classicRecoveryMarker: "from-before-provider-request",
				};
			});
			pi.on("after_provider_response", (event) => {
				afterProviderResponses.push({ status: event.status, headers: event.headers });
			});
		},
	]);
	const { session } = await createAgentSession({
		model,
		modelRuntime,
		sessionManager,
		settingsManager,
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});
	return {
		session,
		sessionManager,
		settingsManager,
		model,
		classicRequests,
		afterProviderResponses,
		compactEvents,
	};
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const summaryUsage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							usage: summaryUsage,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const statsBefore = harness.session.getSessionStats();

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const estimatedTokensAfter = harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);

		expect(result.summary).toBe("summary from extension");
		expect(result.usage).toEqual(summaryUsage);
		expect(result.estimatedTokensAfter).toBe(estimatedTokensAfter);
		expect(compactionEntries).toHaveLength(1);
		const compactionEntry = compactionEntries[0];
		if (compactionEntry?.type === "compaction") {
			expect(compactionEntry.usage).toEqual(summaryUsage);
		}
		const statsAfter = harness.session.getSessionStats();
		expect(statsAfter.tokens.input).toBe(statsBefore.tokens.input + summaryUsage.input);
		expect(statsAfter.tokens.output).toBe(statsBefore.tokens.output + summaryUsage.output);
		expect(statsAfter.tokens.cacheRead).toBe(statsBefore.tokens.cacheRead + summaryUsage.cacheRead);
		expect(statsAfter.tokens.cacheWrite).toBe(statsBefore.tokens.cacheWrite + summaryUsage.cacheWrite);
		expect(statsAfter.cost).toBe(statsBefore.cost + summaryUsage.cost.total);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("allows a queued prompt to start when manual compaction ends", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "manual compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("queued response")]);

		let queuedPrompt: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.reason === "manual" && event.result) {
				expect(harness.session.isCompacting).toBe(false);
				queuedPrompt = harness.session.prompt("queued after compaction");
			}
		});

		await harness.session.compact();
		if (!queuedPrompt) throw new Error("compaction_end did not start the queued prompt");
		await queuedPrompt;

		expect(getUserTexts(harness)).toContain("queued after compaction");
		expect(harness.session.getLastAssistantText()).toBe("queued response");
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("uses remote replacement history for official OpenAI Responses compaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		configureRemoteOpenAIModel(harness);
		let streamCalls = 0;
		harness.session.agent.streamFunction = () => {
			streamCalls++;
			return createAssistantMessageEventStream();
		};
		const compactOutput = remoteCompactOutput();
		const { requests } = mockRemoteCompactHttp({ output: compactOutput });

		const result = await harness.session.compact();
		const compactionEntry = harness.sessionManager
			.getEntries()
			.slice()
			.reverse()
			.find((entry) => entry.type === "compaction");

		expect(streamCalls).toBe(0);
		expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses/compact");
		expect(requests[0]?.body).toContain("message to compact");
		expect(requests[0]?.body).not.toContain("assistant response to compact");
		expect(result.summary).toBe("Responses remote compaction");
		expect(result.details).toEqual({
			type: "openaiResponses",
			compaction: expect.objectContaining({
				identity: {
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5.4",
					endpoint: "https://api.openai.com/v1",
				},
				output: compactOutput,
			}),
		});
		expect(compactionEntry).toMatchObject({ details: result.details });
		const summary = harness.session.messages.find((message) => message.role === "compactionSummary");
		expect(summary).toMatchObject({ remote: expect.objectContaining({ output: compactOutput }) });
	});

	it("rejects malformed persisted remote compaction details", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedCompactableSession(harness);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction("remote", firstKeptEntryId, 100, {
			type: "openaiResponses",
			compaction: { model: "gpt-5.4", output: "not-an-array" },
		});

		expect(() => harness.sessionManager.buildSessionContext()).toThrow("Invalid OpenAI Responses compaction details");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary from custom stream");
		expect(getStreamCallCount()).toBe(1);
	});

	it("manually compacts with provider-resolved bearer auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const model = harness.getModel();
		harness.session.modelRuntime.registerNativeProvider({
			id: model.provider,
			name: "Faux bearer provider",
			auth: {
				apiKey: {
					name: "Faux bearer token",
					resolve: async () => ({
						auth: { headers: { Authorization: "Bearer ambient-token" } },
						source: "ambient bearer token",
					}),
				},
			},
			getModels: () => harness.models,
			stream: () => createAssistantMessageEventStream(),
			streamSimple: () => createAssistantMessageEventStream(),
		});
		seedCompactableSession(harness);
		harness.setResponses([
			(_context, options) => {
				expect(options?.apiKey).toBeUndefined();
				expect(options?.headers).toEqual({ Authorization: "Bearer ambient-token" });
				return fauxAssistantMessage("summary with bearer auth");
			},
		]);

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary with bearer auth");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("persists usage from pi-generated manual compaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(result.usage).toEqual(createUsage(10));
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]?.type === "compaction" ? compactionEntries[0].usage : undefined).toEqual(
			createUsage(10),
		);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "auto summary from custom stream");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEnd?.result?.estimatedTokensAfter).toBeGreaterThan(0);
		expect(getStreamCallCount()).toBe(1);
	});

	it("compacts and resumes after a length stop below the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			fauxAssistantMessage("completed response"),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		expect(harness.session.getLastAssistantText()).toBe("completed response");
	});

	it("does not compact when a length stop reaches the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(400), { stopReason: "length" })]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("stops after one compact-and-retry when a second response is also truncated", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			() => fauxAssistantMessage("x".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
			() => fauxAssistantMessage("y".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_start").filter((event) => event.reason === "overflow")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toBe(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("compacts successful overflow responses without retrying", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "successful overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});

	it("extension compaction preempts remote HTTP for a remote-capable model", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "extension wins",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		configureRemoteOpenAIModel(harness);
		const getClassicCalls = useSummaryStreamFn(harness, "classic should not run");
		const { requests } = mockRemoteCompactHttp({});

		const result = await harness.session.compact();

		expect(result.summary).toBe("extension wins");
		expect(requests).toHaveLength(0);
		expect(getClassicCalls()).toBe(0);
	});

	it("attempts remote compaction for third-party openai-responses baseUrl", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		configureRemoteOpenAIModel(harness, { baseUrl: "https://example-proxy.test/v1" });
		const getClassicCalls = useSummaryStreamFn(harness, "classic should not run");
		const { requests } = mockRemoteCompactHttp({});

		const result = await harness.session.compact();

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://example-proxy.test/v1/responses/compact");
		expect(getClassicCalls()).toBe(0);
		expect(result.details).toEqual({
			type: "openaiResponses",
			compaction: expect.objectContaining({
				identity: expect.objectContaining({
					endpoint: "https://example-proxy.test/v1",
				}),
			}),
		});
	});

	it("falls back once to classic after remote failure and retries remote later", async () => {
		const warnings: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createUiContext((message, type) => warnings.push({ message, type })),
			mode: "tui",
		});
		seedCompactableSession(harness);
		configureRemoteOpenAIModel(harness);
		const getClassicCalls = useSummaryStreamFn(harness, "classic fallback summary");
		const { requests } = mockRemoteCompactHttp({
			success: false,
			body: "remote compact failed: no /responses/compact",
		});

		const first = await harness.session.compact();

		expect(first.summary).toContain("classic fallback summary");
		expect(requests).toHaveLength(1);
		expect(getClassicCalls()).toBe(1);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.type).toBe("warning");
		expect(warnings[0]?.message).toMatch(/^Remote compaction unavailable; using classic compaction: /);
		expect(warnings[0]?.message.length).toBeLessThanOrEqual(220);
		expect(warnings[0]?.message).toMatch(/failed|reject|500|error/i);

		seedCompactableSession(harness, {
			userText: "second wave user",
			assistantText: "second wave assistant",
			timestamp: Date.now() + 10_000,
		});
		vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			requests.push({ url, body: String(init?.body ?? "") });
			return new Response(
				JSON.stringify({
					id: "resp_compact_2",
					created_at: 2,
					object: "response.compaction",
					output: remoteCompactOutput("opaque-2"),
					usage: {
						input_tokens: 4,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens: 1,
						output_tokens_details: { reasoning_tokens: 0 },
						total_tokens: 5,
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		const second = await harness.session.compact();

		expect(requests).toHaveLength(2);
		expect(requests[1]?.url).toBe("https://api.openai.com/v1/responses/compact");
		expect(second.summary).toBe("Responses remote compaction");
		expect(getClassicCalls()).toBe(1);
		expect(warnings).toHaveLength(1);
		// Classic fallback summary must be folded into the later remote retry input exactly once.
		expect(countOccurrences(requests[1]?.body ?? "", "classic fallback summary")).toBe(1);
		expect(requests[1]?.body).toContain(
			"The conversation history before this point was compacted into the following summary",
		);
	});

	it("folds classic previousSummary into subsequent remote compact input exactly once", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const classicSummary = "classic prior summary content unique-xyz";
		const getClassicCalls = useSummaryStreamFn(harness, classicSummary);
		const classicResult = await harness.session.compact();
		expect(classicResult.summary).toContain(classicSummary);
		expect(getClassicCalls()).toBe(1);

		seedCompactableSession(harness, {
			userText: "after classic user",
			assistantText: "after classic assistant",
			timestamp: Date.now() + 5_000,
		});
		configureRemoteOpenAIModel(harness);
		const { requests } = mockRemoteCompactHttp({ output: remoteCompactOutput("opaque-after-classic") });

		const remoteResult = await harness.session.compact();

		expect(remoteResult.summary).toBe("Responses remote compaction");
		expect(requests).toHaveLength(1);
		expect(countOccurrences(requests[0]?.body ?? "", classicSummary)).toBe(1);
		expect(requests[0]?.body).toContain(
			"The conversation history before this point was compacted into the following summary",
		);
		expect(requests[0]?.body).toContain("after classic user");
		// New remote entry displaced classic from context; prior summary only lives in remote input.
		const context = harness.sessionManager.buildSessionContext().messages;
		const summaries = context.filter((message) => message.role === "compactionSummary");
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.summary).toBe("Responses remote compaction");
		expect(summaries[0]?.remote).toBeTruthy();
	});

	it("folds extension previousSummary into subsequent remote compact input exactly once", async () => {
		const extensionSummary = "extension prior summary content unique-abc";
		let extensionUses = 0;
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						if (extensionUses > 0) return undefined;
						extensionUses++;
						return {
							compaction: {
								summary: extensionSummary,
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: { source: "extension-prior" },
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		// Auth/model required before compact() even when extension supplies the result.
		configureRemoteOpenAIModel(harness);
		const extensionResult = await harness.session.compact();
		expect(extensionResult.summary).toBe(extensionSummary);
		expect(extensionUses).toBe(1);

		seedCompactableSession(harness, {
			userText: "after extension user",
			assistantText: "after extension assistant",
			timestamp: Date.now() + 5_000,
		});
		// Re-apply remote model after seed (assistant messages may rebind faux metadata only).
		configureRemoteOpenAIModel(harness);
		const getClassicCalls = useSummaryStreamFn(harness, "classic should not run");
		const { requests } = mockRemoteCompactHttp({ output: remoteCompactOutput("opaque-after-extension") });

		const remoteResult = await harness.session.compact();

		expect(remoteResult.summary).toBe("Responses remote compaction");
		expect(requests).toHaveLength(1);
		expect(getClassicCalls()).toBe(0);
		expect(countOccurrences(requests[0]?.body ?? "", extensionSummary)).toBe(1);
		expect(requests[0]?.body).toContain(
			"The conversation history before this point was compacted into the following summary",
		);
		expect(requests[0]?.body).toContain("after extension user");
	});

	it("direct compact after disabling remote rebuilds raw history through the classic recovery stream", async () => {
		const runtime = await createProductionRemoteSession();
		const { session, sessionManager, model, classicRequests } = runtime;
		seedProductionSession(sessionManager, model, "raw disabled prefix", "raw disabled assistant");
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		const remoteRequests = mockRemoteCompactHttp({ output: remoteCompactOutput("opaque-disabled-direct") });
		await session.compact();

		seedProductionSession(
			sessionManager,
			model,
			"raw disabled suffix",
			"disabled suffix assistant",
			Date.now() + 20_000,
		);
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		session.setRemoteCompactionEnabled(false);

		const result = await session.compact();
		const requests = classicRequests.map((entry) => JSON.stringify(entry.context)).join("\n");

		expect(result.summary).toContain("production classic summary");
		expect(remoteRequests.requests).toHaveLength(1);
		expect(classicRequests.length).toBeGreaterThanOrEqual(1);
		expect(countOccurrences(requests, "raw disabled prefix")).toBe(1);
		expect(countOccurrences(requests, "raw disabled suffix")).toBe(1);
		expect(requests).not.toContain("opaque-disabled-direct");
		expect(requests).not.toContain("Responses remote compaction");
		session.dispose();
	});

	it("direct compact after remote identity mismatch uses classic raw recovery without remote HTTP", async () => {
		const runtime = await createProductionRemoteSession();
		const { session, sessionManager, model, classicRequests } = runtime;
		seedProductionSession(sessionManager, model, "raw mismatch prefix", "raw mismatch assistant");
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		const remoteRequests = mockRemoteCompactHttp({ output: remoteCompactOutput("opaque-mismatch-direct") });
		await session.compact();

		seedProductionSession(
			sessionManager,
			model,
			"raw mismatch suffix",
			"mismatch suffix assistant",
			Date.now() + 20_000,
		);
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		session.agent.state.model = { ...model, id: "changed-model" };

		const result = await session.compact();
		const requests = classicRequests.map((entry) => JSON.stringify(entry.context)).join("\n");

		expect(result.summary).toContain("production classic summary");
		expect(remoteRequests.requests).toHaveLength(1);
		expect(classicRequests.length).toBeGreaterThanOrEqual(1);
		expect(countOccurrences(requests, "raw mismatch prefix")).toBe(1);
		expect(countOccurrences(requests, "raw mismatch suffix")).toBe(1);
		expect(requests).not.toContain("opaque-mismatch-direct");
		expect(requests).not.toContain("Responses remote compaction");
		session.dispose();
	});

	it("auto-compaction after disabling remote rebuilds raw history through the classic recovery stream", async () => {
		const runtime = await createProductionRemoteSession();
		const { session, sessionManager, model, classicRequests } = runtime;
		seedProductionSession(sessionManager, model, "raw auto-disabled prefix", "raw auto-disabled assistant");
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		const remoteRequests = mockRemoteCompactHttp({ output: remoteCompactOutput("opaque-auto-disabled") });
		await session.compact();

		seedProductionSession(
			sessionManager,
			model,
			"raw auto-disabled suffix",
			"auto-disabled suffix assistant",
			Date.now() + 20_000,
		);
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		session.setRemoteCompactionEnabled(false);
		const sessionInternals = session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);
		const requests = classicRequests.map((entry) => JSON.stringify(entry.context)).join("\n");

		expect(remoteRequests.requests).toHaveLength(1);
		expect(classicRequests.length).toBeGreaterThanOrEqual(1);
		expect(countOccurrences(requests, "raw auto-disabled prefix")).toBe(1);
		expect(countOccurrences(requests, "raw auto-disabled suffix")).toBe(1);
		expect(requests).not.toContain("opaque-auto-disabled");
		expect(requests).not.toContain("Responses remote compaction");
		session.dispose();
	});

	it("does not classic-fallback when remote compaction is aborted by signal", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		configureRemoteOpenAIModel(harness);
		const getClassicCalls = useSummaryStreamFn(harness, "classic must not run");
		mockRemoteCompactHttp({ waitForAbort: true });

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toBeTruthy();
		expect(getClassicCalls()).toBe(0);
		const end = harness.eventsOfType("compaction_end").at(-1);
		expect(end?.aborted).toBe(true);
	});

	it("does not classic-fallback when remote throws AbortError without signal abort", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		configureRemoteOpenAIModel(harness);
		const getClassicCalls = useSummaryStreamFn(harness, "classic must not run");
		// Exercise AgentSession abort classification directly: the OpenAI SDK remaps bare
		// fetch AbortError into connection errors, so the public abort contract is the session seam.
		const abortError = new Error("remote aborted");
		abortError.name = "AbortError";
		vi.spyOn(
			harness.session as unknown as { _compactResponses: () => Promise<unknown> },
			"_compactResponses",
		).mockRejectedValue(abortError);

		await expect(harness.session.compact()).rejects.toMatchObject({ name: "AbortError" });
		expect(getClassicCalls()).toBe(0);
	});

	it("does not classic-fallback when auto remote compaction is aborted", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		configureRemoteOpenAIModel(harness);
		const getClassicCalls = useSummaryStreamFn(harness, "classic must not run");
		mockRemoteCompactHttp({ waitForAbort: true });
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		const autoPromise = sessionInternals._runAutoCompaction("overflow", true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(autoPromise).resolves.toBe(false);
		expect(getClassicCalls()).toBe(0);
		const end = harness.eventsOfType("compaction_end").at(-1);
		expect(end?.aborted).toBe(true);
	});

	it("bypasses opaque replay through the production streamFn when persisted remote identity changes", async () => {
		const runtime = await createProductionRemoteSession();
		const { session, sessionManager, model, classicRequests, afterProviderResponses } = runtime;
		const defaultStreamFn = session.agent.streamFunction;
		seedProductionSession(sessionManager, model, "raw identity prefix", "raw identity assistant");
		const firstKeptEntryId = sessionManager.getEntries()[1]!.id;
		sessionManager.appendCompaction("Responses remote compaction", firstKeptEntryId, 100, {
			type: "openaiResponses",
			compaction: {
				identity: {
					api: "openai-responses",
					provider: "old-provider",
					model: "old-model",
					endpoint: "https://old.example/v1",
				},
				output: remoteCompactOutput("opaque-identity-mismatch"),
				usage: createUsage(15),
			},
		});
		session.agent.state.messages = sessionManager.buildSessionContext().messages;

		const recovered = await session.recoverRemoteCompactionContext(session.messages);
		const request = JSON.stringify(classicRequests[0]?.context);

		expect(session.agent.streamFunction).toBe(defaultStreamFn);
		expect(classicRequests).toHaveLength(1);
		expect(countOccurrences(request, "raw identity prefix")).toBe(1);
		expect(request).not.toContain("opaque-identity-mismatch");
		expect(request).not.toContain("Responses remote compaction");
		expect(classicRequests[0]?.options).toMatchObject({
			apiKey: "runtime-key",
			headers: { "x-runtime-auth": "resolved" },
			env: { RUNTIME_ENV: "resolved" },
		});
		expect(classicRequests[0]?.options?.onPayload).toBeTypeOf("function");
		expect(classicRequests[0]?.options?.onResponse).toBeTypeOf("function");
		expect(classicRequests[0]?.payload).toMatchObject({
			classicRecoveryMarker: "from-before-provider-request",
		});
		expect(afterProviderResponses).toEqual([{ status: 200, headers: { "x-classic": "1" } }]);
		expect(recovered.find((message) => message.role === "compactionSummary")).toMatchObject({
			summary: expect.stringContaining("production classic summary"),
			remote: undefined,
		});
		session.dispose();
	});

	it("keeps exact Codex instructions on iterative remote compaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const systemPrompt = "Exact real coding-agent instructions; never helper default.";
		harness.session.agent.state.systemPrompt = systemPrompt;
		seedCompactableSession(harness);
		configureRemoteCodexModel(harness);
		const { requests } = mockRemoteCompactHttp({ output: remoteCompactOutput("opaque-codex-first") });

		await harness.session.compact();
		seedCompactableSession(harness, {
			userText: "second Codex wave",
			assistantText: "second Codex response",
			timestamp: Date.now() + 20_000,
		});
		await harness.session.compact();

		expect(requests).toHaveLength(2);
		const secondBody = JSON.parse(requests[1]!.body) as { instructions?: string; input?: unknown[] };
		expect(secondBody.instructions).toBe(systemPrompt);
		expect(secondBody.instructions).not.toBe("You are a helpful assistant.");
		expect(JSON.stringify(secondBody.input)).toContain("opaque-codex-first");
	});

	it("iterative remote session_compact event references the newly appended compaction", async () => {
		const runtime = await createProductionRemoteSession();
		const { session, sessionManager, model, compactEvents } = runtime;
		seedProductionSession(sessionManager, model, "event prefix", "event assistant");
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		mockRemoteCompactHttp({ output: remoteCompactOutput("opaque-event-first") });

		await session.compact();
		seedProductionSession(sessionManager, model, "event suffix", "event suffix assistant", Date.now() + 20_000);
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		mockRemoteCompactHttp({ output: remoteCompactOutput("opaque-event-second") });

		await session.compact();

		expect(compactEvents).toHaveLength(2);
		expect(compactEvents[1]?.id).not.toBe(compactEvents[0]?.id);
		expect(compactEvents[0]?.details).toMatchObject({
			type: "openaiResponses",
			compaction: {
				output: expect.arrayContaining([expect.objectContaining({ encrypted_content: "opaque-event-first" })]),
			},
		});
		expect(compactEvents[1]?.details).toMatchObject({
			type: "openaiResponses",
			compaction: {
				output: expect.arrayContaining([expect.objectContaining({ encrypted_content: "opaque-event-second" })]),
			},
		});
		expect(compactEvents[1]?.usage).toEqual({
			input: 10,
			output: 3,
			cacheRead: 2,
			cacheWrite: 0,
			totalTokens: 15,
			reasoning: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		session.dispose();
	});

	it("classic-falls back from iterative remote failure through the production streamFn using only raw history", async () => {
		const runtime = await createProductionRemoteSession();
		const { session, sessionManager, model, classicRequests, afterProviderResponses } = runtime;
		const defaultStreamFn = session.agent.streamFunction;
		seedProductionSession(sessionManager, model, "raw iterative prefix", "raw iterative assistant");
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		mockRemoteCompactHttp({ output: remoteCompactOutput("opaque-iterative-first") });

		const remoteResult = await session.compact();
		expect(remoteResult.summary).toBe("Responses remote compaction");
		// Non-empty trailing assistant so keepRecentTokens=1 keeps it and leaves the suffix user in the summarize window.
		seedProductionSession(
			sessionManager,
			model,
			"raw iterative suffix",
			"suffix assistant reply",
			Date.now() + 20_000,
		);
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		mockRemoteCompactHttp({ success: false, body: "iterative remote failed" });

		const classicResult = await session.compact();
		const request = classicRequests.map((entry) => JSON.stringify(entry.context)).join("\n");

		expect(session.agent.streamFunction).toBe(defaultStreamFn);
		expect(classicRequests.length).toBeGreaterThanOrEqual(1);
		expect(classicResult.summary).toContain("production classic summary");
		expect(countOccurrences(request, "raw iterative prefix")).toBe(1);
		expect(countOccurrences(request, "raw iterative suffix")).toBe(1);
		expect(request).not.toContain("opaque-iterative-first");
		expect(request).not.toContain("Responses remote compaction");
		for (const classicRequest of classicRequests) {
			expect(classicRequest.options?.onPayload).toBeTypeOf("function");
			expect(classicRequest.options?.onResponse).toBeTypeOf("function");
			expect(classicRequest.payload).toMatchObject({
				classicRecoveryMarker: "from-before-provider-request",
			});
		}
		// Remote compact also emits after_provider_response; each classic recovery call must still fire once.
		expect(afterProviderResponses.filter((event) => event.headers["x-classic"] === "1")).toEqual(
			classicRequests.map(() => ({ status: 200, headers: { "x-classic": "1" } })),
		);
		expect(session.messages.find((message) => message.role === "compactionSummary")).not.toHaveProperty(
			"remote",
			expect.anything(),
		);
		session.dispose();
	});

	it("classic-rebuilds raw history after iterative remote success then remote failure", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness, {
			userText: "old-prefix-message",
			assistantText: "old-prefix-assistant",
		});
		configureRemoteOpenAIModel(harness);
		mockRemoteCompactHttp({ output: remoteCompactOutput("opaque-first") });

		const remoteResult = await harness.session.compact();
		expect(remoteResult.summary).toBe("Responses remote compaction");
		const firstKeptEntryId = remoteResult.firstKeptEntryId;

		seedCompactableSession(harness, {
			userText: "suffix-to-summarize",
			assistantText: "suffix-assistant",
			timestamp: Date.now() + 20_000,
		});

		const classicBodies: string[] = [];
		let classicCalls = 0;
		harness.session.agent.streamFunction = (_model, context) => {
			classicCalls++;
			classicBodies.push(JSON.stringify(context.messages));
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					...fauxAssistantMessage("rebuilt classic summary"),
					api: _model.api,
					provider: _model.provider,
					model: _model.id,
					usage: createUsage(10),
				};
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		mockRemoteCompactHttp({ success: false, body: "iterative remote failed" });

		const classicResult = await harness.session.compact();
		const joined = classicBodies.join("\n");

		expect(classicCalls).toBeGreaterThanOrEqual(1);
		expect(classicResult.summary).toContain("rebuilt classic summary");
		expect(countOccurrences(joined, "old-prefix-message")).toBe(1);
		expect(countOccurrences(joined, "suffix-to-summarize")).toBe(1);
		expect(joined).not.toContain("encrypted_content");
		expect(joined).not.toContain("<previous-summary>\nResponses remote compaction\n</previous-summary>");
		expect(classicResult.firstKeptEntryId).toBeTruthy();
		expect(classicResult.firstKeptEntryId).not.toBe(firstKeptEntryId);
		const summaryMessage = harness.session.messages.find((message) => message.role === "compactionSummary");
		expect(summaryMessage).toMatchObject({ summary: expect.stringContaining("rebuilt classic summary") });
		expect(summaryMessage).not.toHaveProperty("remote", expect.anything());
		expect((summaryMessage as { remote?: unknown } | undefined)?.remote).toBeUndefined();
	});

	it("recovers classic context when remote is disabled without leaking opaque output", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			// keepRecentTokens must live in base settings: setRemoteCompactionEnabled() save() rebuilds from storage and drops applyOverrides.
			settings: { images: { blockImages: true }, compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => ({
						messages: event.messages.map((message) =>
							message.role === "user" && Array.isArray(message.content)
								? {
										...message,
										content: message.content.map((part) =>
											part.type === "text" ? { ...part, text: `xformed:${part.text}` } : part,
										),
									}
								: message,
						),
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness, {
			userText: "disable-remote-prefix",
			assistantText: "disable-remote-assistant",
		});
		configureRemoteOpenAIModel(harness);
		mockRemoteCompactHttp({ output: remoteCompactOutput("opaque-disabled") });
		await harness.session.compact();

		harness.sessionManager.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "post-remote kept" },
				{
					type: "image",
					data: "AAAA",
					mimeType: "image/png",
				},
			],
			timestamp: Date.now() + 5_000,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.session.setRemoteCompactionEnabled(false);

		useSummaryStreamFn(harness, "recovered classic after disable");
		let transformCalls = 0;
		let convertCalls = 0;
		const originalTransform = harness.session.agent.transformContext;
		harness.session.agent.transformContext = async (messages, signal) => {
			transformCalls++;
			const recovered = await harness.session.recoverRemoteCompactionContext(messages, signal);
			return originalTransform ? originalTransform(recovered, signal) : recovered;
		};
		harness.session.agent.convertToLlm = (messages: AgentMessage[]) => {
			convertCalls++;
			return convertToLlm(messages).map((msg) => {
				if ((msg.role === "user" || msg.role === "toolResult") && Array.isArray(msg.content)) {
					const hasImages = msg.content.some((part) => part.type === "image");
					if (!hasImages) return msg;
					return {
						...msg,
						content: msg.content.map((part) =>
							part.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : part,
						),
					};
				}
				return msg;
			});
		};

		const recovered = await harness.session.agent.transformContext!(
			harness.session.messages,
			new AbortController().signal,
		);
		const forProvider = await harness.session.agent.convertToLlm!(recovered);
		const serialized = JSON.stringify(forProvider);

		expect(transformCalls).toBe(1);
		expect(convertCalls).toBe(1);
		expect(serialized).not.toContain("encrypted_content");
		expect(serialized).not.toContain("opaque-disabled");
		expect(serialized).toContain("Image reading is disabled.");
		expect(serialized).toMatch(/xformed:post-remote kept|post-remote kept/);
		const summary = recovered.find((message) => message.role === "compactionSummary");
		expect(summary).toMatchObject({ summary: expect.stringContaining("recovered classic after disable") });
		expect((summary as { remote?: unknown } | undefined)?.remote).toBeUndefined();
	});

	it("recovers classic context when endpoint identity becomes incompatible", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness, {
			userText: "identity-prefix",
			assistantText: "identity-assistant",
		});
		const model = configureRemoteOpenAIModel(harness, { baseUrl: "https://first.example/v1" });
		mockRemoteCompactHttp({ output: remoteCompactOutput("opaque-identity") });
		await harness.session.compact();

		harness.session.agent.state.model = { ...model, baseUrl: "https://second.example/v1" };
		useSummaryStreamFn(harness, "recovered after identity change");

		const recovered = await harness.session.recoverRemoteCompactionContext(harness.session.messages);
		const serialized = JSON.stringify(convertToLlm(recovered));

		expect(serialized).not.toContain("encrypted_content");
		expect(serialized).not.toContain("opaque-identity");
		expect(serialized).toContain("recovered after identity change");
		expect(recovered.find((message) => message.role === "compactionSummary")).toMatchObject({
			summary: expect.stringContaining("recovered after identity change"),
			remote: undefined,
		});
	});

	it("replays compatible remote opaque output after persisted session reload", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-remote-compact-reload-"));
		try {
			const session = SessionManager.create(tempDir, tempDir);
			const userId = session.appendMessage({
				role: "user",
				content: [{ type: "text", text: "reload-prefix" }],
				timestamp: Date.now() - 1000,
			});
			session.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "reload-assistant" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.4",
				usage: createUsage(20),
				stopReason: "stop",
				timestamp: Date.now() - 500,
			} as AssistantMessage);
			const compactOutput = remoteCompactOutput("opaque-reload");
			session.appendCompaction("Responses remote compaction", userId, 100, {
				type: "openaiResponses",
				compaction: {
					identity: {
						api: "openai-responses",
						provider: "openai",
						model: "gpt-5.4",
						endpoint: "https://api.openai.com/v1",
					},
					output: compactOutput,
					usage: createUsage(15),
				},
			});
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("expected session file");

			const reopened = SessionManager.open(sessionFile, tempDir);
			const context = reopened.buildSessionContext();
			const summary = context.messages.find((message) => message.role === "compactionSummary");

			expect(summary).toMatchObject({
				summary: "Responses remote compaction",
				remote: {
					identity: {
						api: "openai-responses",
						provider: "openai",
						model: "gpt-5.4",
						endpoint: "https://api.openai.com/v1",
					},
					output: compactOutput,
				},
			});
			expect(JSON.stringify(convertToLlm(context.messages))).not.toContain("encrypted_content");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
