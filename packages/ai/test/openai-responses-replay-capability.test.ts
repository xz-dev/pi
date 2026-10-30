import { expect, expectTypeOf, it, vi } from "vitest";
import { openAIResponsesApi } from "../src/compat.ts";
import type { ProviderStreams } from "../src/types.ts";

const { nativeLoaded } = vi.hoisted(() => ({ nativeLoaded: vi.fn() }));
vi.mock("../src/api/openai-responses.ts", () => {
	nativeLoaded();
	return { stream: vi.fn(), streamSimple: vi.fn() };
});

it("advertises background replay synchronously without loading the native implementation", () => {
	expect(nativeLoaded).not.toHaveBeenCalled();
	const api = openAIResponsesApi();
	expect(api.supportsBackgroundResponseReplay).toBe(true);
	expect(typeof api.stream).toBe("function");
	expect(typeof api.streamSimple).toBe("function");
	expectTypeOf(api).toExtend<ProviderStreams>();
	expectTypeOf(api.supportsBackgroundResponseReplay).toEqualTypeOf<true>();
	expect(nativeLoaded).not.toHaveBeenCalled();
});
