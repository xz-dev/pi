import { createAssistantMessageEventStream, getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentMessage, AgentTool } from "../src/types.ts";

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: Date.now() });

describe("prepareInput", () => {
	it.each(["steer", "followUp"] as const)("prepares initial input and %s batches before events", async (queue) => {
		const faux = registerFauxProvider();
		const order: string[] = [];
		const batches: AgentMessage[][] = [];
		const requests: AgentMessage[][] = [];
		const model = faux.getModel();
		const replacement = user("replacement context");
		let calls = 0;
		const agent = new Agent({
			initialState: { model, messages: [user("old context")] },
			prepareInput: ({ context, messages }, signal) => {
				expect(signal?.aborted).toBe(false);
				expect(context.messages).not.toContain(messages[0]);
				batches.push(messages);
				order.push(`prepare:${batches.length}`);
				return { context: { ...context, messages: [replacement] }, model, thinkingLevel: "low" };
			},
			prepareNextTurn: () => ({ messages: [user("prepared")] }),
			streamFn: (_model, context, options) => {
				expect(options?.reasoning).toBe("low");
				requests.push(context.messages);
				calls++;
				if (calls === 1) agent[queue](user("queued"));
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("done") }));
				return stream;
			},
		});
		agent.subscribe((event: AgentEvent) => {
			if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "user") {
				order.push(`${event.type}:${event.message.content}`);
			}
		});
		try {
			await agent.prompt(user("initial"));
			expect(order).toEqual([
				"prepare:1",
				"message_start:initial",
				"message_end:initial",
				"prepare:2",
				"message_start:prepared",
				"message_end:prepared",
				"message_start:queued",
				"message_end:queued",
			]);
			expect(
				batches.map((batch) => batch.map((message) => (message.role === "user" ? message.content : ""))),
			).toEqual([["initial"], ["prepared", "queued"]]);
			expect(
				requests.map((messages) => messages.map((message) => (message.role === "user" ? message.content : ""))),
			).toEqual([
				["replacement context", "initial"],
				["replacement context", "prepared", "queued"],
			]);
		} finally {
			faux.unregister();
		}
	});

	it.each(["steer", "followUp"] as const)(
		"delivers prepared and %s input before reporting preparation failure",
		async (queue) => {
			const faux = registerFauxProvider();
			let preparations = 0;
			let providerCalls = 0;
			const agent = new Agent({
				initialState: { model: faux.getModel() },
				prepareInput: () => {
					if (++preparations === 2) throw new Error("preparation failed");
				},
				prepareNextTurn: () => ({ messages: [user("prepared")] }),
				streamFn: () => {
					providerCalls++;
					agent[queue](user("queued"));
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() =>
						stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("first answer") }),
					);
					return stream;
				},
			});
			try {
				await agent.prompt(user("initial"));
				expect(
					agent.state.messages.filter((message) => message.role === "user").map((message) => message.content),
				).toEqual(["initial", "prepared", "queued"]);
				expect(agent.state.messages.at(-1)).toMatchObject({
					role: "assistant",
					stopReason: "error",
					errorMessage: "preparation failed",
				});
				expect(providerCalls).toBe(1);
			} finally {
				faux.unregister();
			}
		},
	);

	it.each(["throw", "abort"] as const)(
		"reconciles the latest tool loadout when preparation fails via %s",
		async (failure) => {
			const faux = registerFauxProvider();
			const oldTool: AgentTool = {
				name: "old",
				label: "Old",
				description: "Old tool",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: undefined }),
			};
			const newTool: AgentTool = { ...oldTool, name: "new", label: "New", description: "New tool" };
			const context: AgentContext = {
				messages: [
					{ role: "system", content: "", toolsAdded: [toToolDeclaration(oldTool)], timestamp: Date.now() },
				],
				tools: [oldTool],
			};
			const transcript = context.messages.slice();
			const controller = new AbortController();
			let providerCalls = 0;
			try {
				await expect(
					runAgentLoop(
						[user("saved input")],
						context,
						{
							model: faux.getModel(),
							convertToLlm: () => [],
							prepareInput: ({ context }) => {
								if (failure === "throw") {
									context.tools = [newTool];
									throw new Error("preparation failed");
								}
								controller.abort();
								return { context: { ...context, tools: [newTool] } };
							},
						},
						(event) => {
							if (event.type === "message_end") transcript.push(event.message);
						},
						controller.signal,
						() => {
							providerCalls++;
							return createAssistantMessageEventStream();
						},
					),
				).rejects.toThrow(failure === "throw" ? "preparation failed" : "aborted");
				expect(getCurrentTools(transcript)).toEqual([toToolDeclaration(newTool)]);
				expect(transcript.at(-1)).toMatchObject({ role: "user", content: "saved input" });
				expect(providerCalls).toBe(0);
			} finally {
				faux.unregister();
			}
		},
	);

	it("keeps startup steering queued when an initial input listener throws", async () => {
		const faux = registerFauxProvider();
		const queued = user("queued steering");
		let starts = 0;
		let providerCalls = 0;
		const agent = new Agent({
			initialState: { model: faux.getModel() },
			prepareInput: () => undefined,
			streamFn: () => {
				providerCalls++;
				return createAssistantMessageEventStream();
			},
		});
		agent.steer(queued);
		agent.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") {
				starts++;
				throw new Error("listener failed");
			}
		});
		try {
			await agent.prompt(user("initial"));
			expect(agent.peekQueuedMessages()).toEqual([queued]);
			expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", errorMessage: "listener failed" });
			expect(starts).toBe(1);
			expect(providerCalls).toBe(0);
		} finally {
			faux.unregister();
		}
	});

	it("prepares initial prompt before polling startup steering as a separate batch", async () => {
		const faux = registerFauxProvider();
		const order: string[] = [];
		const agent = new Agent({
			initialState: { model: faux.getModel() },
			prepareInput: ({ context, messages }) => {
				if (messages[0]?.role === "user" && messages[0].content === "queued")
					expect(
						context.messages.some((message) => message.role === "user" && message.content === "initial"),
					).toBe(true);
				order.push(
					`prepare:${messages.map((message) => (message.role === "user" ? message.content : "")).join(",")}`,
				);
			},
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("done") }));
				return stream;
			},
		});
		agent.steer(user("queued"));
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "user") order.push(`end:${event.message.content}`);
		});
		try {
			await agent.prompt(user("initial"));
			expect(order).toEqual(["prepare:initial", "end:initial", "prepare:queued", "end:queued"]);
		} finally {
			faux.unregister();
		}
	});

	it("aborts a non-cooperative preparation wait and delivers accepted input", async () => {
		const faux = registerFauxProvider();
		let started = () => {};
		const preparing = new Promise<void>((resolve) => {
			started = resolve;
		});
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let providerCalls = 0;
		const agent = new Agent({
			initialState: { model: faux.getModel() },
			prepareInput: async () => {
				started();
				await blocked;
			},
			streamFn: () => {
				providerCalls++;
				return createAssistantMessageEventStream();
			},
		});
		try {
			const prompt = agent.prompt(user("saved while blocked"));
			await preparing;
			agent.abort();
			await prompt;
			expect(agent.state.messages[0]).toMatchObject({ role: "user", content: "saved while blocked" });
			expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
			expect(providerCalls).toBe(0);
		} finally {
			release();
			faux.unregister();
		}
	});

	it("persists input without calling provider after preparation aborts", async () => {
		const faux = registerFauxProvider();
		const events: AgentEvent[] = [];
		let providerCalls = 0;
		const agent = new Agent({
			initialState: { model: faux.getModel() },
			prepareInput: () => {
				agent.abort();
			},
			streamFn: () => {
				providerCalls++;
				return createAssistantMessageEventStream();
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});
		try {
			await agent.prompt(user("saved input"));
			expect(events.filter((event) => event.type === "message_start" && event.message.role === "user")).toHaveLength(
				1,
			);
			expect(events.filter((event) => event.type === "message_end" && event.message.role === "user")).toHaveLength(
				1,
			);
			expect(agent.state.messages[0]).toMatchObject({ role: "user", content: "saved input" });
			expect(providerCalls).toBe(0);
			expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		} finally {
			faux.unregister();
		}
	});
});
