import { afterEach, describe, expect, test, vi } from "vitest";
import * as config from "../src/config.ts";
import { buildSystemPromptState } from "../src/core/system-prompt.ts";

afterEach(() => vi.restoreAllMocks());

describe("embedded documentation in system prompts", () => {
	test("materializes docs before exposing paths without changing hidden-tool rules", () => {
		const materialize = vi.spyOn(config, "ensureMaterializedDocs");
		const docsPath = config.getDocsPath;
		vi.spyOn(config, "getDocsPath").mockImplementation(() => {
			expect(materialize).toHaveBeenCalledOnce();
			return docsPath();
		});
		const { sections } = buildSystemPromptState({
			cwd: "/workspace",
			selectedTools: ["bash"],
			hiddenTools: ["bash"],
		});
		expect(sections?.docs).toContain(docsPath());
		expect(sections?.rules).not.toContain("Use bash for file operations");
	});

	test.each([{ customPrompt: "custom" }, { forceSystemPrompt: "forced" }])(
		"does not materialize docs for a replacement prompt: %j",
		(options) => {
			const materialize = vi.spyOn(config, "ensureMaterializedDocs");
			buildSystemPromptState({ cwd: "/workspace", ...options });
			expect(materialize).not.toHaveBeenCalled();
		},
	);
});
