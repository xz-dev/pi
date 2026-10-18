import { describe, expect, it } from "vitest";
import {
	canonicalJson,
	captureCheckpoint,
	checkpointPrefixHash,
	isResponseCheckpoint,
	planCheckpoint,
	requestEnvelopeHash,
	responseEventOutput,
	responseOutputItemsCapturable,
	sha256Hex,
} from "../src/utils/response-checkpoints.ts";

const NOW = 1_760_000_000_000;
const SCOPE_A = "a".repeat(64);
const SCOPE_B = "b".repeat(64);

function userInput(text: string) {
	return { role: "user", content: [{ type: "input_text", text }] };
}
function assistantItem(text: string, id = "msg_1") {
	return {
		type: "message",
		id,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
}
function reasoningItem(id = "rs_1", encrypted = "enc_blob") {
	return { type: "reasoning", id, summary: [], encrypted_content: encrypted };
}
function functionCallItem(callId = "call_1", itemId = "fc_1") {
	return { type: "function_call", id: itemId, call_id: callId, name: "do_thing", arguments: '{"x":1}' };
}
function toolOutputItem(callId = "call_1", out = "result") {
	return { type: "function_call_output", call_id: callId, output: out };
}

function baseRequest(input: unknown[] = [userInput("Hello")]) {
	return { model: "gpt-5.5", store: true, input, reasoning: { effort: "medium" } };
}

async function captureValid(overrides: Record<string, unknown> = {}) {
	const request = baseRequest();
	const prefix = [...(request.input as unknown[]), assistantItem("Hi")];
	return captureCheckpoint({
		request,
		responseId: "resp_1",
		encodedPrefix: prefix,
		scopeHash: SCOPE_A,
		completed: true,
		stored: true,
		fullHistory: true,
		now: NOW,
		...overrides,
	});
}

describe("canonicalJson + sha256Hex", () => {
	it("sorts object keys recursively, preserves array order", () => {
		expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
		expect(canonicalJson([2, 1])).toBe("[2,1]");
	});
	it("drops undefined object values like JSON.stringify", () => {
		expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
	});
	it("hashes a string to 64 hex chars", async () => {
		expect(await sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("captureCheckpoint", () => {
	it("captures v1 metadata for a completed stored turn (example 1)", async () => {
		const meta = await captureValid();
		expect(meta).toBeDefined();
		expect(meta!.version).toBe(1);
		expect(meta!.inputCount).toBe(2); // 1 user input + 1 assistant item
		expect(meta!.createdAt).toBe(NOW);
		expect(meta!.expiresAt).toBeUndefined();
		expect(isResponseCheckpoint(meta)).toBe(true);
		// Round-trips through JSON serialization (JSONL persistence).
		expect(isResponseCheckpoint(JSON.parse(JSON.stringify(meta)))).toBe(true);
	});
	it("keeps metadata bounded: hashes/counts/times only, no payload (example 8)", async () => {
		const meta = await captureValid();
		expect(Object.keys(meta!).sort()).toEqual([
			"createdAt",
			"inputCount",
			"prefixHash",
			"requestHash",
			"scopeHash",
			"version",
		]);
		expect(meta!.prefixHash).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(meta)).not.toContain("Hello");
		expect(JSON.stringify(meta)).not.toContain("sk-");
	});
	it("does not include the responseId in the metadata object", async () => {
		const meta = await captureValid();
		expect(JSON.stringify(meta)).not.toContain("resp_1");
	});
	it.each([
		["uncompleted", { completed: false }],
		["unstored", { stored: false }],
		["incomplete local history", { fullHistory: false }],
		["empty responseId", { responseId: "" }],
	])("refuses capture when %s", async (_name, overrides) => {
		expect(await captureValid(overrides)).toBeUndefined();
	});
	it("keeps the optional known expiry when given", async () => {
		const meta = await captureValid({ expiresAt: NOW + 1000 });
		expect(meta!.expiresAt).toBe(NOW + 1000);
	});
});

describe("isResponseCheckpoint validation", () => {
	it("accepts a valid object", async () => {
		expect(isResponseCheckpoint(await captureValid())).toBe(true);
	});
	it("rejects malformed shapes", async () => {
		const valid = await captureValid();
		const cases: [string, unknown][] = [
			["null", null],
			["string", "x"],
			["wrong version", { ...valid, version: 2 }],
			["missing hash", { ...valid, scopeHash: undefined }],
			["non-hex hash", { ...valid, prefixHash: "zz" }],
			["negative inputCount", { ...valid, inputCount: -1 }],
			["fractional inputCount", { ...valid, inputCount: 1.5 }],
			["missing createdAt", { ...valid, createdAt: undefined }],
			["bad expiresAt", { ...valid, expiresAt: "soon" }],
		];
		for (const [name, value] of cases) {
			expect(isResponseCheckpoint(value), name).toBe(false);
		}
	});
});

describe("planCheckpoint", () => {
	async function setup(overrides: Record<string, unknown> = {}) {
		const meta = (await captureValid(overrides))!;
		const request = baseRequest();
		return { meta, request };
	}

	it("sends only the trailing input with previous_response_id (example 1)", async () => {
		const { meta, request } = await setup();
		// Next request: same envelope, input = prefix + new user turn.
		const nextInput = [...(request.input as unknown[]), assistantItem("Hi"), userInput("Second")];
		const nextRequest = { ...request, input: nextInput };
		const plan = await planCheckpoint({
			request: nextRequest,
			candidate: { responseId: "resp_1", responseCheckpoint: meta },
			scopeHash: SCOPE_A,
			now: NOW + 1,
			eligible: true,
		});
		expect(plan).toBeDefined();
		expect(plan!.previousResponseId).toBe("resp_1");
		expect(plan!.matchedInputCount).toBe(2);
		expect(plan!.request.previous_response_id).toBe("resp_1");
		expect(plan!.request.input).toEqual([userInput("Second")]);
		// Original request untouched.
		expect((nextRequest as Record<string, unknown>).previous_response_id).toBeUndefined();
		expect((nextRequest.input as unknown[]).length).toBe(3);
	});

	it("empty delta yields no plan (example 7)", async () => {
		const { meta, request } = await setup();
		const sameInput = [...(request.input as unknown[]), assistantItem("Hi")];
		const plan = await planCheckpoint({
			request: { ...request, input: sameInput },
			candidate: { responseId: "resp_1", responseCheckpoint: meta },
			scopeHash: SCOPE_A,
			now: NOW + 1,
			eligible: true,
		});
		expect(plan).toBeUndefined();
	});

	it("rollback to an older active-branch checkpoint uses its exact suffix (example 2)", async () => {
		// Turn 1 captured checkpoint; turn 2 happened then was rolled back.
		const { meta, request } = await setup();
		const input = [
			...(request.input as unknown[]),
			assistantItem("Hi"),
			userInput("Again"), // new branch tail after rollback
		];
		const plan = await planCheckpoint({
			request: { ...request, input },
			candidate: { responseId: "resp_1", responseCheckpoint: meta },
			scopeHash: SCOPE_A,
			now: NOW + 1,
			eligible: true,
		});
		expect(plan).toBeDefined();
		expect(plan!.request.input).toEqual([userInput("Again")]);
		expect(plan!.previousResponseId).toBe("resp_1");
	});

	it("function-call turn + tool result tail resumes with tool output only (example 3)", async () => {
		const prefix = [
			userInput("call the tool"),
			reasoningItem(),
			functionCallItem("call_server_1"),
			assistantItem("working"),
		];
		const request = { ...baseRequest([userInput("call the tool")]), input: [userInput("call the tool")] };
		const meta = await captureCheckpoint({
			request,
			responseId: "resp_fc",
			encodedPrefix: prefix,
			scopeHash: SCOPE_A,
			completed: true,
			stored: true,
			fullHistory: true,
			now: NOW,
		});
		const nextRequest = { ...request, input: [...prefix, toolOutputItem("call_server_1", "tool result")] };
		const plan = await planCheckpoint({
			request: nextRequest,
			candidate: { responseId: "resp_fc", responseCheckpoint: meta },
			scopeHash: SCOPE_A,
			now: NOW + 1,
			eligible: true,
		});
		expect(plan).toBeDefined();
		expect(plan!.request.input).toEqual([toolOutputItem("call_server_1", "tool result")]);
	});

	it.each([
		[
			"changed prefix text",
			(req: Record<string, unknown>) => ({
				...req,
				input: [userInput("Edited"), assistantItem("Hi"), userInput("Second")],
			}),
		],
		[
			"changed assistant output in prefix",
			(req: Record<string, unknown>) => ({
				...req,
				input: [...(req.input as unknown[]), assistantItem("Different"), userInput("Second")],
			}),
		],
		[
			"changed request envelope",
			(req: Record<string, unknown>) => ({
				...req,
				model: "gpt-5.6",
				input: [...(req.input as unknown[]), assistantItem("Hi"), userInput("Second")],
			}),
		],
		[
			"changed tool settings",
			(req: Record<string, unknown>) => ({
				...req,
				reasoning: { effort: "high" },
				input: [...(req.input as unknown[]), assistantItem("Hi"), userInput("Second")],
			}),
		],
	])("invalidates on %s (example 4)", async (_name, mutate) => {
		const { meta, request } = await setup();
		const plan = await planCheckpoint({
			request: mutate(request),
			candidate: { responseId: "resp_1", responseCheckpoint: meta },
			scopeHash: SCOPE_A,
			now: NOW + 1,
			eligible: true,
		});
		expect(plan).toBeUndefined();
	});

	it("scope/account mismatch refuses resume (example 5)", async () => {
		const { meta, request } = await setup();
		const plan = await planCheckpoint({
			request: {
				...request,
				input: [...(request.input as unknown[]), assistantItem("Hi"), userInput("Second")],
			},
			candidate: { responseId: "resp_1", responseCheckpoint: meta },
			scopeHash: SCOPE_B,
			now: NOW + 1,
			eligible: true,
		});
		expect(plan).toBeUndefined();
	});

	it("expired checkpoint refuses resume (example 5)", async () => {
		const meta = (await captureValid({ expiresAt: NOW + 500 }))!;
		const request = baseRequest();
		const plan = await planCheckpoint({
			request: {
				...request,
				input: [...(request.input as unknown[]), assistantItem("Hi"), userInput("Second")],
			},
			candidate: { responseId: "resp_1", responseCheckpoint: meta },
			scopeHash: SCOPE_A,
			now: NOW + 501,
			eligible: true,
		});
		expect(plan).toBeUndefined();
	});

	it("malformed metadata refuses resume without throwing (example 5)", async () => {
		const request = baseRequest();
		const plan = await planCheckpoint({
			request: { ...request, input: [...(request.input as unknown[]), userInput("Second")] },
			candidate: { responseId: "resp_1", responseCheckpoint: { version: 99 } },
			scopeHash: SCOPE_A,
			now: NOW + 1,
			eligible: true,
		});
		expect(plan).toBeUndefined();
	});

	it("changed candidate responseId fails prefix binding (example 6)", async () => {
		const { meta, request } = await setup();
		const plan = await planCheckpoint({
			request: {
				...request,
				input: [...(request.input as unknown[]), assistantItem("Hi"), userInput("Second")],
			},
			candidate: { responseId: "resp_other", responseCheckpoint: meta },
			scopeHash: SCOPE_A,
			now: NOW + 1,
			eligible: true,
		});
		expect(plan).toBeUndefined();
	});

	it("responseId alone never enables a plan without metadata", async () => {
		const request = baseRequest();
		const plan = await planCheckpoint({
			request: { ...request, input: [...(request.input as unknown[]), userInput("Second")] },
			candidate: { responseId: "resp_1" },
			scopeHash: SCOPE_A,
			now: NOW + 1,
			eligible: true,
		});
		expect(plan).toBeUndefined();
	});

	it("unsafe trailing assistant/opaque item refuses layering (example 7)", async () => {
		const { meta, request } = await setup();
		const input = [
			...(request.input as unknown[]),
			assistantItem("Hi"),
			assistantItem("Unfinished next turn"), // still assistant output — unsafe delta
		];
		const plan = await planCheckpoint({
			request: { ...request, input },
			candidate: { responseId: "resp_1", responseCheckpoint: meta },
			scopeHash: SCOPE_A,
			now: NOW + 1,
			eligible: true,
		});
		expect(plan).toBeUndefined();
	});

	it("caller-owned previous_response_id refuses layering (example 7)", async () => {
		const { meta, request } = await setup();
		const plan = await planCheckpoint({
			request: {
				...request,
				previous_response_id: "resp_caller",
				input: [...(request.input as unknown[]), assistantItem("Hi"), userInput("Second")],
			},
			candidate: { responseId: "resp_1", responseCheckpoint: meta },
			scopeHash: SCOPE_A,
			now: NOW + 1,
			eligible: true,
		});
		expect(plan).toBeUndefined();
	});

	it("resolved eligibility=false never plans", async () => {
		const { meta, request } = await setup();
		const plan = await planCheckpoint({
			request: {
				...request,
				input: [...(request.input as unknown[]), assistantItem("Hi"), userInput("Second")],
			},
			candidate: { responseId: "resp_1", responseCheckpoint: meta },
			scopeHash: SCOPE_A,
			now: NOW + 1,
			eligible: false,
		});
		expect(plan).toBeUndefined();
	});

	it("requestHash ignores framing fields stream/type/previous_response_id", async () => {
		const a = await requestEnvelopeHash(baseRequest());
		const b = await requestEnvelopeHash({
			...baseRequest(),
			stream: true,
			type: "response.create",
			previous_response_id: "resp_x",
		});
		expect(a).toBe(b);
	});

	it("prefixHash binds responseId plus full prefix", async () => {
		const prefix = [userInput("A"), assistantItem("B")];
		const h1 = await checkpointPrefixHash("resp_1", prefix);
		const h2 = await checkpointPrefixHash("resp_2", prefix);
		const h3 = await checkpointPrefixHash("resp_1", [userInput("A"), assistantItem("C")]);
		expect(h1).not.toBe(h2);
		expect(h1).not.toBe(h3);
	});
});

describe("output capture eligibility", () => {
	it("accepts message/function_call/reasoning items", () => {
		const items = [assistantItem("x"), functionCallItem(), reasoningItem()];
		expect(responseOutputItemsCapturable(items, items)).toBe(true);
	});
	it.each([
		["empty output", []],
		["unknown type", [{ type: "mystery_widget" }]],
		["computer_call", [{ type: "computer_call" }]],
		["non-object", ["text"]],
		["missing type", [{ id: "x" }]],
	])("rejects %s", (_name, output) => {
		expect(responseOutputItemsCapturable(output as unknown[], output)).toBe(false);
	});
	it("ignores output_text logprobs metadata (prod gateways emit logprobs: []) but still compares text", () => {
		const encoded = assistantItem("ok") as { content: Record<string, unknown>[] };
		const withLogprobs = { ...encoded, content: encoded.content.map((part) => ({ ...part, logprobs: [] })) };
		expect(responseOutputItemsCapturable([withLogprobs], [encoded])).toBe(true);
		const changed = { ...withLogprobs, content: withLogprobs.content.map((part) => ({ ...part, text: "no" })) };
		expect(responseOutputItemsCapturable([changed], [encoded])).toBe(false);
	});
	it("compares exact tool argument bytes and opaque reasoning, allowing only omitted tool status", () => {
		const call = functionCallItem();
		expect(responseOutputItemsCapturable([{ ...call, status: "completed" }], [call])).toBe(true);
		for (const changed of [
			{ ...call, arguments: '{"x": 1}' },
			{ ...call, call_id: "different" },
			{ ...call, id: "fc_other" },
			{ ...call, namespace: "other" },
		])
			expect(responseOutputItemsCapturable([changed], [call])).toBe(false);
		expect(responseOutputItemsCapturable([reasoningItem()], [reasoningItem("rs_1", "changed")])).toBe(false);
		expect(responseOutputItemsCapturable([assistantItem("whole")], [assistantItem("part")])).toBe(false);
	});
	it.each(["response.incomplete", "response.done", "response.failed", "response.cancelled"])(
		"does not treat %s as completed even with completed status",
		(type) => {
			expect(
				responseEventOutput({
					type,
					response: { id: "resp_1", status: "completed", output: [assistantItem("x")] },
				}),
			).toBeUndefined();
		},
	);
	it("responseEventOutput extracts id/output/store", () => {
		expect(
			responseEventOutput({
				type: "response.completed",
				response: { id: "resp_9", status: "completed", output: [assistantItem("x")], store: true },
			}),
		).toEqual({ id: "resp_9", output: [assistantItem("x")], store: true });
		expect(responseEventOutput({ response: { id: "resp_9" } })).toBeUndefined();
		expect(responseEventOutput({})).toBeUndefined();
	});
});
