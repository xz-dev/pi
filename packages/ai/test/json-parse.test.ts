import { describe, expect, it } from "vitest";
import { encodeToolCallArguments, parseStreamingJson, parseToolCallArguments } from "../src/utils/json-parse.ts";

describe("parseStreamingJson", () => {
	// #10868
	it("keeps invalid \\u escapes as literal text without dropping fields", () => {
		expect(parseStreamingJson(String.raw`{"text":"\url{x}"}`)).toEqual({ text: "\\url{x}" });
		expect(parseStreamingJson(String.raw`{"path":"a.tex","content":"\usepackage{x}","mode":"w"}`)).toEqual({
			path: "a.tex",
			content: "\\usepackage{x}",
			mode: "w",
		});
	});

	it("decodes valid \\u escapes", () => {
		expect(parseStreamingJson(String.raw`{"text":"caf\u00e9 \url"}`)).toEqual({ text: "café \\url" });
	});

	it("omits a \\u escape that is cut off mid-stream", () => {
		expect(parseStreamingJson(String.raw`{"text":"ab\u00`)).toEqual({ text: "ab" });
	});
});

// #10897
describe("parseToolCallArguments", () => {
	it("parses complete JSON and repairs invalid escapes", () => {
		expect(parseToolCallArguments(String.raw`{"kind":"seek","note":"\url"}`)).toEqual({
			arguments: { kind: "seek", note: "\\url" },
		});
	});

	it("uses empty arguments for empty text", () => {
		expect(parseToolCallArguments("")).toEqual({ arguments: {} });
	});

	it("does not keep the valid prefix of malformed JSON", () => {
		const raw = '{"action":"apply","actions":[{"kind":"seek","time":.5}]}';
		const result = parseToolCallArguments(raw);
		expect(result.arguments).toEqual({});
		expect(result.argumentsError).toMatch(/\n\nReceived arguments:\n/);
		expect(result.argumentsError?.endsWith(raw)).toBe(true);
	});

	it("does not complete cut-off JSON", () => {
		const raw = '{"kind":"seek","clipId":"clip-fl';
		const result = parseToolCallArguments(raw);
		expect(result.arguments).toEqual({});
		expect(result.argumentsError?.endsWith(raw)).toBe(true);
	});

	it("rejects JSON that is not an object", () => {
		expect(parseToolCallArguments("[1,2]")).toEqual({
			arguments: {},
			argumentsError: "Tool arguments must be a JSON object\n\nReceived arguments:\n[1,2]",
		});
	});
});

describe("encodeToolCallArguments", () => {
	const raw = '{"command": "echo one"}';

	it("replays the model's original text unchanged", () => {
		expect(encodeToolCallArguments(parseToolCallArguments(raw, { keepJson: true }))).toBe(raw);
	});

	it("keeps no text that a fresh encoding reproduces, or when not asked to", () => {
		expect(parseToolCallArguments('{"a":1}', { keepJson: true }).argumentsJson).toBeUndefined();
		expect(parseToolCallArguments(raw).argumentsJson).toBeUndefined();
	});

	it("re-encodes arguments that no longer match the original text", () => {
		const call = { ...parseToolCallArguments(raw, { keepJson: true }), arguments: { command: "echo two" } };
		expect(encodeToolCallArguments(call)).toBe('{"command":"echo two"}');
	});

	it("does not keep repaired text, which is not valid JSON", () => {
		const call = parseToolCallArguments(String.raw`{"note": "\url"}`, { keepJson: true });
		expect(call.argumentsJson).toBeUndefined();
		expect(encodeToolCallArguments(call)).toBe(JSON.stringify({ note: "\\url" }));
	});

	it("encodes calls without original text", () => {
		expect(encodeToolCallArguments({ arguments: { a: 1 } })).toBe('{"a":1}');
	});
});
