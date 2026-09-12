import { FinishReason } from "@google/genai";
import { describe, expect, it } from "vitest";
import { mapStopReason } from "../src/api/google-shared.ts";

describe("mapStopReason", () => {
	it("maps TOO_MANY_TOOL_CALLS to error", () => {
		expect(mapStopReason(FinishReason.TOO_MANY_TOOL_CALLS)).toBe("error");
	});

	it("maps STOP to stop", () => {
		expect(mapStopReason(FinishReason.STOP)).toBe("stop");
	});
});
