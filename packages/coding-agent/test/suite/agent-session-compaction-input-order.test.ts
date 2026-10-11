import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { estimateProjectedContextTokens, estimateTokens } from "../../src/core/compaction/index.ts";
import { VIRTUAL_MODEL_STATE_ENTRY } from "../../src/core/virtual-models.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("input compaction ordering", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("keeps manual retry recovery context when an input batch declares tools", async () => {
		const routedInputs: string[][] = [];
		const harness = await createHarness({
			tools: [
				{
					name: "lookup",
					label: "Lookup",
					description: "Lookup",
					parameters: Type.Object({}),
					execute: async () => ({ content: [], details: undefined }),
				},
			],
			initialActiveToolNames: ["lookup"],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.registerVirtualModel({
						provider: "router",
						id: "auto",
						name: "Auto",
						route(request, ctx) {
							routedInputs.push(request.messages.map(getMessageText));
							return { model: ctx.modelRegistry.find("faux", "faux-1")!, thinkingLevel: "off" };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.setModel(harness.session.modelRuntime.getModel("router", "auto")!);
		harness.sessionManager.appendMessage({ role: "user", content: "original input", timestamp: Date.now() });
		harness.sessionManager.appendMessage(fauxAssistantMessage("partial answer", { stopReason: "aborted" }));
		harness.session.refreshContext();
		let batches = 0;
		const prepare = harness.session.agent.prepareInput!;
		harness.session.agent.prepareInput = (input, signal) => {
			batches++;
			return prepare(input, signal);
		};
		harness.setResponses([fauxAssistantMessage("recovered answer")]);
		await harness.session.retry();
		expect(batches).toBe(1);
		expect(routedInputs).toHaveLength(1);
		expect(routedInputs[0]).toContain("original input");
		expect(routedInputs[0].some((text) => text.includes("partial answer") && text.includes("interrupted"))).toBe(
			true,
		);
		expect(harness.session.getLastAssistantText()).toBe("recovered answer");
	});

	it("persists the pending prompt when pre-input compaction is aborted", async () => {
		let started = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const harness = await createHarness({
			models: [{ id: "physical", contextWindow: 6000 }],
			settings: { compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on(
						"session_before_compact",
						(event) =>
							new Promise<{ cancel: true }>((resolve) => {
								event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
								started();
							}),
					);
				},
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "old input", timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("old answer"),
			provider: "faux",
			model: "physical",
			timestamp: Date.now() - 500,
		});
		harness.session.refreshContext();
		const input = `saved input:${"x".repeat(24000)}`;
		const prompt = harness.session.prompt(input);
		await compactionStarted;
		harness.session.agent.abort();
		await prompt;
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true });
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "message" && getMessageText(entry.message) === input),
		).toBe(true);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
	});

	it("keeps input and auto-retries when input routing fails", async () => {
		const reasons: string[] = [];
		let failNext = false;
		const harness = await createHarness({
			settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.registerVirtualModel({
						provider: "router",
						id: "auto",
						name: "Auto",
						route(request, ctx) {
							reasons.push(request.reason);
							if (failNext) {
								failNext = false;
								throw new Error("overloaded_error");
							}
							return { model: ctx.modelRegistry.find("faux", "faux-1")!, thinkingLevel: "off" };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.setModel(harness.session.modelRuntime.getModel("router", "auto")!);
		harness.setResponses([
			fauxAssistantMessage("seed answer"),
			(context) => {
				expect(context.messages.some((message) => getMessageText(message) === "saved after routing failure")).toBe(
					true,
				);
				return fauxAssistantMessage("retried answer");
			},
		]);
		await harness.session.prompt("seed input");
		failNext = true;
		await harness.session.prompt("saved after routing failure", { source: "interactive" });
		expect(reasons).toEqual(["user", "user", "retry"]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.getLastAssistantText()).toBe("retried answer");
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) => entry.type === "message" && getMessageText(entry.message) === "saved after routing failure",
				),
		).toBe(true);
		expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({ success: true });
	});

	it.each(["transformation", "selection", "thinking", "physical-to-virtual"] as const)(
		"invalidates input handoff after %s changes",
		async (change) => {
			const routes: Array<{ selection: string; input: string; thinking: string }> = [];
			const harness = await createHarness({
				models: [
					{ id: "large", contextWindow: 50000 },
					{ id: "small", contextWindow: 2000 },
				],
				tools: [],
				settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						for (const id of ["A", "B"])
							pi.registerVirtualModel({
								provider: "router",
								id,
								name: id,
								thinkingLevels: ["off", "high"],
								route(request, ctx) {
									const input = getMessageText(
										request.messages.findLast((message) => message.role === "user"),
									);
									routes.push({ selection: id, input, thinking: request.thinkingLevel });
									const small = id === "B" || input === "transformed" || request.thinkingLevel === "high";
									return {
										model: ctx.modelRegistry.find("faux", small ? "small" : "large")!,
										thinkingLevel: "off",
									};
								},
							});
						pi.on("message_start", async (event, ctx) => {
							if (event.message.role !== "user") return;
							if (change === "selection" || change === "physical-to-virtual")
								await harness.session.setModel(ctx.modelRegistry.find("router", "B")!);
							if (change === "thinking") pi.setThinkingLevel("high");
						});
						pi.on("message_end", (event) =>
							change === "transformation" && event.message.role === "user"
								? { message: { ...event.message, content: "transformed" } }
								: undefined,
						);
						pi.on("session_before_compact", ({ preparation }) => ({
							compaction: {
								summary: "fallback summary",
								firstKeptEntryId: preparation.firstKeptEntryId,
								tokensBefore: preparation.tokensBefore,
							},
						}));
					},
				],
			});
			harnesses.push(harness);
			if (change !== "physical-to-virtual")
				await harness.session.setModel(harness.session.modelRuntime.getModel("router", "A")!);
			else {
				harness.sessionManager.appendMessage({
					role: "user",
					content: "x".repeat(16000),
					timestamp: Date.now() - 1000,
				});
				harness.sessionManager.appendMessage({
					...fauxAssistantMessage("old answer"),
					provider: "faux",
					model: "large",
					timestamp: Date.now() - 500,
				});
				harness.session.refreshContext();
			}
			harness.session.setThinkingLevel("off");
			harness.setResponses([
				(_context, _options, _state, model) => {
					expect(model.id).toBe("small");
					return fauxAssistantMessage("small answer");
				},
			]);
			await harness.session.prompt("original", { source: "interactive" });
			expect(routes.map((route) => route.selection)).toEqual(
				change === "physical-to-virtual" ? ["B"] : change === "selection" ? ["A", "B"] : ["A", "A"],
			);
			expect(routes.at(-1)).toMatchObject({
				input: change === "transformation" ? "transformed" : "original",
				thinking: change === "thinking" ? "high" : "off",
			});
			expect(harness.session.messages.at(-1)).toMatchObject({
				role: "assistant",
				model: "small",
				stopReason: "stop",
			});
			if (change === "physical-to-virtual") {
				expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
				const branch = harness.sessionManager.getBranch();
				expect(branch.findIndex((entry) => entry.type === "compaction")).toBeGreaterThan(
					branch.findIndex((entry) => entry.type === "message" && getMessageText(entry.message) === "original"),
				);
			}
		},
	);

	it.each(["prompt", "steer", "followUp", "previous-turn", "virtual"] as const)(
		"compacts before delivering %s input",
		async (kind) => {
			const routes: string[] = [];
			const input = kind === "previous-turn" ? "next prompt" : `incoming:${"x".repeat(4000)}`;
			const inputTokens = estimateTokens({ role: "user", content: input, timestamp: Date.now() });
			const usage = {
				input: kind === "previous-turn" ? 5900 : 5800 - inputTokens + 1,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const harness = await createHarness({
				models: [{ id: "physical", contextWindow: 6000 }],
				settings: { compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("message_end", (event) =>
							event.message.role === "assistant" && getMessageText(event.message) === "first turn"
								? { message: { ...event.message, usage } }
								: undefined,
						);
						pi.on("session_before_compact", (event) => {
							expect(
								event.branchEntries.some(
									(entry) => entry.type === "message" && getMessageText(entry.message) === input,
								),
							).toBe(false);
							return {
								compaction: {
									summary: "old history compacted",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
						if (kind === "virtual")
							pi.registerVirtualModel({
								provider: "router",
								id: "auto",
								name: "Auto",
								contextWindow: 100000,
								route(request, ctx) {
									routes.push(request.reason);
									expect(request.messages.some((message) => getMessageText(message) === input)).toBe(true);
									return {
										model: ctx.modelRegistry.find("faux", "physical")!,
										thinkingLevel: "off",
										state: { routed: true },
									};
								},
							});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("new response")]);
			harness.sessionManager.appendMessage({ role: "user", content: "seed input", timestamp: Date.now() - 1000 });
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage("seed response"),
				api: harness.getModel().api,
				provider: "faux",
				model: "physical",
				timestamp: Date.now() - 500,
				usage: kind === "steer" || kind === "followUp" ? { ...usage, input: 100 } : usage,
			});
			harness.session.refreshContext();
			const seedEntry = harness.sessionManager
				.getBranch()
				.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
			const seedAssistant = seedEntry?.type === "message" ? seedEntry.message : undefined;
			if (seedAssistant?.role !== "assistant") throw new Error("missing seed response");
			const projected = estimateProjectedContextTokens(
				harness.sessionManager.buildSessionProjection(),
				harness.sessionManager.getBranch(),
			).tokens;
			// Pending input crosses threshold; previous-turn case crosses already.
			expect(kind === "previous-turn" ? projected > 5800 : projected <= 5800).toBe(true);
			if (kind === "virtual")
				await harness.session.setModel(harness.session.modelRuntime.getModel("router", "auto")!);

			if (kind === "steer" || kind === "followUp") {
				// Queue after current response starts, so input is delivered by runLoop, not initial prompt.
				harness.setResponses([
					(context) => {
						expect(context.messages.some((message) => getMessageText(message) === input)).toBe(false);
						harness.session.agent[kind]({ role: "user", content: input, timestamp: Date.now() });
						return { ...fauxAssistantMessage("first turn"), usage };
					},
					fauxAssistantMessage("new response"),
				]);
				await harness.session.prompt("run first turn");
			} else await harness.session.prompt(input, { source: "interactive" });

			const branch = harness.sessionManager.getBranch();
			const compactionIndex = branch.findIndex((entry) => entry.type === "compaction");
			const inputIndex = branch.findIndex(
				(entry) => entry.type === "message" && getMessageText(entry.message) === input,
			);
			expect(compactionIndex).toBeGreaterThan(-1);
			expect(inputIndex).toBeGreaterThan(compactionIndex);
			expect(
				branch
					.slice(compactionIndex + 1, inputIndex)
					.every((entry) => entry.type === "message" && entry.message.role === "system"),
			).toBe(true);
			expect(branch[inputIndex + 1]).toMatchObject({ type: "message", message: { role: "assistant" } });
			const compaction = branch[compactionIndex];
			if (compaction.type !== "compaction") throw new Error("missing compaction");
			expect(compaction.firstKeptEntryId).not.toBe(branch[inputIndex].id);
			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
			const delivered = harness.events.findIndex(
				(event) => event.type === "message_start" && getMessageText(event.message) === input,
			);
			expect(harness.events.findIndex((event) => event.type === "compaction_end")).toBeLessThan(delivered);
			if (kind === "virtual") {
				expect(routes).toEqual(["user"]);
				expect(branch[compactionIndex - 1]).toMatchObject({
					type: "custom",
					customType: VIRTUAL_MODEL_STATE_ENTRY,
				});
			}
		},
	);
});
