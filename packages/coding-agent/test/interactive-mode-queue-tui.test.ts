import type { Context } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./test-harness.ts";

const ALT_ENTER = "\x1b[27;3;13~";
const ALT_UP = "\x1bp";
const originalPiOffline = process.env.PI_OFFLINE;

function contextUserTexts(context: Context): string[] {
	return context.messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return message.content.flatMap((content) => (content.type === "text" ? [content.text] : []));
	});
}

function createRuntime(harness: Harness): AgentSessionRuntime {
	const services: AgentSessionServices = {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: harness.session.resourceLoader,
		diagnostics: [],
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async () => ({
		session: harness.session,
		services,
		extensionsResult: harness.session.resourceLoader.getExtensions(),
		diagnostics: [],
	});
	return new AgentSessionRuntime(harness.session, services, createRuntime);
}

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

describe("InteractiveMode queued message editing", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	beforeAll(() => {
		process.env.PI_OFFLINE = "1";
		initTheme("dark");
	});

	afterAll(() => {
		if (originalPiOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = originalPiOffline;
	});

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	test("dequeues, edits, and submits queued text through terminal input", async () => {
		const harness = await createHarness({
			responses: [{ text: "first response", delayMs: 250 }, "second response"],
			settings: { quietStartup: true, showHardwareCursor: true },
		});
		const terminal = new VirtualTerminal(100, 30);
		const runtime = createRuntime(harness);
		const interactive = new InteractiveMode(runtime, { terminal });
		cleanups.push(async () => {
			interactive.stop();
			await runtime.dispose();
			harness.cleanup();
		});

		const getUserInput = interactive.getUserInput.bind(interactive);
		const inputWait = vi
			.spyOn(interactive, "getUserInput")
			.mockImplementationOnce(getUserInput)
			.mockImplementationOnce(getUserInput)
			.mockRejectedValue(new Error("test complete"));
		const run = interactive.run();
		const runResult = expect(run).rejects.toThrow("test complete");
		await waitUntil(
			() => terminal.getViewport().some((line) => line.includes("faux-1")),
			"the interactive UI to start",
		);

		terminal.sendInput("initial request");
		terminal.sendInput("\r");
		await waitUntil(() => harness.session.isStreaming, "the first response to start streaming");

		terminal.sendInput("steering draft");
		terminal.sendInput("\r");
		await waitUntil(() => harness.session.getSteeringMessages().length === 1, "the steering message to be queued");
		terminal.sendInput("follow-up draft");
		terminal.sendInput(ALT_ENTER);
		await waitUntil(() => harness.session.pendingMessageCount === 2, "both messages to be queued");
		await terminal.waitForRender();
		const pendingViewport = terminal.getViewport().join("\n");
		expect(pendingViewport).toContain("steering draft");
		expect(pendingViewport).toContain("follow-up draft");

		terminal.sendInput(ALT_UP);
		await waitUntil(() => harness.session.pendingMessageCount === 0, "the queued messages to be restored");
		await terminal.waitForRender();
		const cursorBeforeEdit = terminal.getCursorPosition();
		terminal.sendInput(" edited");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("steering draft");
		expect(terminal.getViewport().join("\n")).toContain("follow-up draft edited");
		expect(terminal.getCursorPosition()).toEqual({
			x: cursorBeforeEdit.x + " edited".length,
			y: cursorBeforeEdit.y,
		});

		await harness.session.waitForIdle();
		terminal.sendInput("\r");
		await waitUntil(() => harness.faux.contexts.length === 2, "the edited text to reach the faux provider");
		await harness.session.waitForIdle();

		const secondRequestTexts = contextUserTexts(harness.faux.contexts[1] as Context);
		expect(secondRequestTexts).toContain("steering draft\n\nfollow-up draft edited");
		expect(secondRequestTexts).not.toContain("steering draft");
		expect(secondRequestTexts).not.toContain("follow-up draft");
		await runResult;
		expect(inputWait).toHaveBeenCalledTimes(3);
		expect(harness.faux.contexts).toHaveLength(2);
	});
});
