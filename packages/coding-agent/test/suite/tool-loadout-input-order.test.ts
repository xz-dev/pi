import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const tool: AgentTool = {
	name: "dummy",
	label: "Dummy",
	description: "Dummy tool",
	parameters: Type.Object({}),
	execute: async () => ({ content: [], details: undefined }),
};

function systems(harness: Harness, originalCwd = harness.tempDir) {
	return harness.sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "system") return [];
		const { timestamp: _timestamp, ...message } = entry.message;
		return [
			JSON.parse(
				JSON.stringify(message).replaceAll(harness.tempDir, "<cwd>").replaceAll(originalCwd, "<cwd>"),
			) as unknown,
		];
	});
}

// Normal SDK startup restores the persisted projection, unlike a standalone Agent's initial prompt.
describe("tool loadout declarations around input preparation", () => {
	it("records first input, changed loadout and resumed input at their request boundaries", async () => {
		const harness = await createHarness({
			tools: [tool],
			initialActiveToolNames: ["dummy"],
			settings: { compaction: { enabled: false } },
		});
		let resumed: Harness | undefined;
		try {
			harness.session.refreshContext();
			harness.setResponses([
				(context) => {
					expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["dummy"]);
					return fauxAssistantMessage("first answer");
				},
			]);
			await harness.session.prompt("first input");
			const firstSystems = systems(harness);
			expect(firstSystems).toHaveLength(1);
			expect(firstSystems[0]).toMatchObject({ toolsAdded: [{ name: "dummy" }] });

			harness.session.setActiveToolsByName([]);
			harness.setResponses([
				(context) => {
					expect(getCurrentTools(context.messages)).toEqual([]);
					return fauxAssistantMessage("second answer");
				},
			]);
			await harness.session.prompt("second input");
			const changedSystems = systems(harness);
			expect(changedSystems).toHaveLength(2);
			expect(changedSystems[1]).toMatchObject({ toolsRemoved: [{ name: "dummy" }] });

			const header = harness.sessionManager.getHeader()!;
			const branch = structuredClone(harness.sessionManager.getBranch());
			resumed = await createHarness({
				tools: [tool],
				initialActiveToolNames: [],
				settings: { compaction: { enabled: false } },
				sessionManagerFactory: () => SessionManager.inMemory(harness.tempDir, undefined, [header, ...branch]),
			});
			resumed.session.refreshContext();
			resumed.setResponses([
				(context) => {
					expect(getCurrentTools(context.messages)).toEqual([]);
					return fauxAssistantMessage("resumed answer");
				},
			]);
			await resumed.session.prompt("resumed input");
			// New cwd can patch prompt sections on resume, but never redeclare the removed tool.
			expect(getCurrentTools(resumed.session.messages)).toEqual([]);
			const resumedSystems = systems(resumed, harness.tempDir);
			expect(resumedSystems.slice(0, changedSystems.length)).toEqual(changedSystems);
			expect(resumedSystems).toHaveLength(3);
			expect(resumedSystems[2]).toMatchObject({ sections: { cwd: expect.any(String) } });
			expect(resumedSystems[2]).not.toHaveProperty("toolsAdded");
			expect(resumedSystems[2]).not.toHaveProperty("toolsRemoved");
		} finally {
			resumed?.cleanup();
			harness.cleanup();
		}
	});
});
