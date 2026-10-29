import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import type { PromptTemplate } from "../../src/core/prompt-templates.ts";
import { getRawInputText } from "../../src/core/raw-input-text.ts";
import { type SessionEntry, SessionManager, type SessionMessageEntry } from "../../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { getSubmittedCommandText } from "../../src/modes/interactive/input-presentation.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

function template(name: string, content: string): PromptTemplate {
	const filePath = `/virtual/${name}.md`;
	return {
		name,
		description: name,
		content,
		filePath,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope: "temporary", origin: "top-level" }),
	};
}

const TEMPLATES = [
	template("review", "Review this code: $1"),
	template("same1", "Same body"),
	template("same2", "Same body"),
	template("noop", "/noop"),
];

function userEntries(entries: readonly SessionEntry[]): SessionMessageEntry[] {
	return entries.filter(
		(entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "user",
	);
}

describe("__raw_inputText session metadata", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	async function setup(options: HarnessOptions & { skillFile?: "present" | "missing" } = {}): Promise<Harness> {
		const skillDir = join(tmpdir(), `pi-raw-input-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(skillDir, { recursive: true });
		tempDirs.push(skillDir);
		const skillPath = join(skillDir, "SKILL.md");
		if (options.skillFile !== "missing") writeFileSync(skillPath, "# Review skill\n\nSkill body.");
		const extensionsResult = options.extensionFactories
			? await createTestExtensionsResult(options.extensionFactories, skillDir)
			: undefined;
		const resourceLoader = {
			...createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined),
			getPrompts: () => ({ prompts: TEMPLATES, diagnostics: [] }),
			getSkills: () => ({
				skills: [
					{
						name: "review",
						description: "Review skill",
						filePath: skillPath,
						disableModelInvocation: false,
						baseDir: skillDir,
						sourceInfo: createSyntheticSourceInfo(skillPath, {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: skillDir,
						}),
					},
				],
				diagnostics: [],
			}),
		};
		const { extensionFactories: _, skillFile: __, ...rest } = options;
		const harness = await createHarness({ ...rest, resourceLoader });
		harnesses.push(harness);
		return harness;
	}

	it("records the full interactive template command on the entry, not in the model message", async () => {
		const harness = await setup();
		let modelText = "";
		const seenAtMessageStart: Array<{ raw: string | undefined; persisted: number }> = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") {
				seenAtMessageStart.push({
					raw: getRawInputText(event.message),
					persisted: userEntries(harness.sessionManager.getEntries()).length,
				});
			}
		});
		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				modelText = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt('/review "src/a b.ts"', { source: "interactive" });

		expect(modelText).toBe("Review this code: src/a b.ts");
		// The TUI sees the command at message_start, before the entry exists.
		expect(seenAtMessageStart).toEqual([{ raw: '/review "src/a b.ts"', persisted: 0 }]);
		const [entry] = userEntries(harness.sessionManager.getEntries());
		expect(entry?.__raw_inputText).toBe('/review "src/a b.ts"');
		expect(getMessageText(entry!.message)).toBe("Review this code: src/a b.ts");
		expect(JSON.stringify(entry!.message)).not.toContain("__raw_inputText");
	});

	it("records metadata regardless of the presentation setting", async () => {
		const harness = await setup({ settings: { collapseExpandedInput: false } });
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("/review x", { source: "interactive" });
		expect(userEntries(harness.sessionManager.getEntries())[0]?.__raw_inputText).toBe("/review x");
	});

	it.each([
		["plain text", "hello there"],
		["unknown command", "/missing arg"],
		["template output identical to input", "/noop"],
		["skill command", "/skill:review look at this"],
	])("does not write the field for %s", async (_label, input) => {
		const harness = await setup();
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt(input, { source: "interactive" });
		const entries = userEntries(harness.sessionManager.getEntries());
		expect(entries).toHaveLength(1);
		expect("__raw_inputText" in entries[0]!).toBe(false);
	});

	it("does not write the field when the skill file cannot be read", async () => {
		const harness = await setup({ skillFile: "missing" });
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("/skill:review x", { source: "interactive" }).catch(() => {});
		for (const entry of userEntries(harness.sessionManager.getEntries())) {
			expect("__raw_inputText" in entry).toBe(false);
		}
	});

	it("does not write the field for SDK input, extension-consumed commands, or rewritten input", async () => {
		const commandRuns: string[] = [];
		let api: ExtensionAPI | undefined;
		const harness = await setup({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.registerCommand("testcmd", {
						description: "t",
						handler: async (args) => void commandRuns.push(args),
					});
					pi.on("input", (event) =>
						event.text === "/review rewrite-me" ? { action: "transform", text: "/review rewritten" } : undefined,
					);
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b"), fauxAssistantMessage("c")]);

		await harness.session.prompt("/testcmd hi", { source: "interactive" });
		await harness.session.sendUserMessage("/review sdk", { expandPromptTemplates: true });
		await harness.session.prompt("/review rewrite-me", { source: "interactive" });
		expect(api).toBeDefined();

		expect(commandRuns).toEqual(["hi"]);
		const entries = userEntries(harness.sessionManager.getEntries());
		expect(entries.map((entry) => getMessageText(entry.message))).toEqual([
			expect.stringMatching(/Review this code: sdk$/),
			"Review this code: rewritten",
		]);
		for (const entry of entries) expect("__raw_inputText" in entry).toBe(false);
	});

	it("round-trips through JSONL and omits the key when absent", async () => {
		const harness = await setup({
			sessionManagerFactory: (dir) => SessionManager.create(dir, dir, { id: "raw-input-roundtrip" }),
		});
		harness.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
		await harness.session.prompt("/review src/x.ts", { source: "interactive" });
		await harness.session.prompt("plain", { source: "interactive" });

		const file = harness.sessionManager.getSessionFile()!;
		const lines = readFileSync(file, "utf8").trim().split("\n");
		const raw = lines.filter((line) => line.includes("__raw_inputText"));
		expect(raw).toHaveLength(1);
		expect(JSON.parse(raw[0]!).__raw_inputText).toBe("/review src/x.ts");
		expect(lines.join("\n")).not.toMatch(/"__raw_inputText":(null|"")/);

		const reopened = SessionManager.open(file, harness.tempDir);
		const [template, plain] = userEntries(reopened.getEntries());
		expect(template?.__raw_inputText).toBe("/review src/x.ts");
		expect(getRawInputText(template!.message)).toBe("/review src/x.ts");
		expect(getMessageText(template!.message)).toBe("Review this code: src/x.ts");
		expect(getRawInputText(plain!.message)).toBeUndefined();

		// Fork copies keep the field.
		const forkFile = reopened.createBranchedSession(template!.id);
		const forked = SessionManager.open(forkFile!, harness.tempDir);
		expect(userEntries(forked.getEntries())[0]?.__raw_inputText).toBe("/review src/x.ts");
	});

	it("ignores invalid stored metadata", async () => {
		const harness = await setup({
			sessionManagerFactory: (dir) => SessionManager.create(dir, dir, { id: "raw-input-invalid" }),
		});
		harness.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
		await harness.session.prompt("first", { source: "interactive" });
		await harness.session.prompt("second", { source: "interactive" });
		const file = harness.sessionManager.getSessionFile()!;
		const invalid: unknown[] = [123, ""];
		const lines = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => {
				const entry = JSON.parse(line);
				if (entry.type === "message" && entry.message.role === "user") entry.__raw_inputText = invalid.shift();
				return JSON.stringify(entry);
			});
		writeFileSync(file, `${lines.join("\n")}\n`);

		const reopened = SessionManager.open(file, harness.tempDir);
		const messages: AgentMessage[] = userEntries(reopened.getEntries()).map((entry) => entry.message);
		expect(messages.map((message) => getRawInputText(message))).toEqual([undefined, undefined]);
		expect(messages.map((message) => getMessageText(message))).toEqual(["first", "second"]);
	});

	it("keeps queued commands with identical expansions matched by identity", async () => {
		let release: () => void = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait",
			parameters: Type.Object({}),
			execute: async () => {
				await released;
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const harness = await setup({ tools: [waitTool] });
		const toolStarted = new Promise<void>((resolve) => {
			harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") resolve();
			});
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("a"),
			fauxAssistantMessage("b"),
			fauxAssistantMessage("c"),
		]);

		const run = harness.session.prompt("start", { source: "interactive" });
		await toolStarted;
		await harness.session.prompt("/same1", { streamingBehavior: "followUp", source: "interactive" });
		await harness.session.prompt("/same2", { streamingBehavior: "followUp", source: "interactive" });
		await harness.session.followUp("/same1", undefined, { source: "sdk" });

		const queued = harness.session.getQueuedInputs().followUp;
		expect(queued.map((message) => getRawInputText(message))).toEqual(["/same1", "/same2", undefined]);

		release();
		await run;
		await harness.session.agent.waitForIdle();

		const entries = userEntries(harness.sessionManager.getEntries()).filter((entry) =>
			getMessageText(entry.message).endsWith("Same body"),
		);
		expect(entries.map((entry) => entry.__raw_inputText)).toEqual(["/same1", "/same2", undefined]);
	});

	it("TUI draft retrieval keeps identity, filtering, and the SDK text API", async () => {
		let release: () => void = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait",
			parameters: Type.Object({}),
			execute: async () => {
				await released;
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const harness = await setup({ tools: [waitTool] });
		const toolStarted = new Promise<void>((resolve) => {
			harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") resolve();
			});
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("a"),
			fauxAssistantMessage("b"),
		]);

		const run = harness.session.prompt("start", { source: "interactive" });
		await toolStarted;
		await harness.session.prompt("/review a", { streamingBehavior: "steer", source: "interactive" });
		await harness.session.followUp("/review sdk", undefined, { source: "sdk" });

		const drafts = harness.session.takeInteractiveDraftMessages();
		expect(drafts.steering.map((message) => getRawInputText(message))).toEqual(["/review a"]);
		expect(drafts.followUp).toEqual([]);
		expect(harness.session.getQueuedInputs().followUp).toHaveLength(1);

		await harness.session.prompt("/review b", { streamingBehavior: "steer", source: "interactive" });
		expect(harness.session.takeInteractiveDrafts().steering).toEqual(["Review this code: b"]);

		release();
		await run;
		await harness.session.agent.waitForIdle();
	});
});

describe("getSubmittedCommandText", () => {
	const skill = (body: string, user?: string) =>
		`<skill name="review" location="/x/SKILL.md">\nReferences are relative to /x.\n\n${body}\n</skill>${user === undefined ? "" : `\n\n${user}`}`;

	it("prefers the recorded raw command", () => {
		expect(getSubmittedCommandText("Review this code: a", "/review a")).toBe("/review a");
	});

	it("rebuilds skill commands from stored skill XML", () => {
		expect(getSubmittedCommandText(skill("Body"), undefined)).toBe("/skill:review");
		expect(getSubmittedCommandText(skill("Body", "line 1\nline 2"), undefined)).toBe("/skill:review line 1\nline 2");
	});

	it("returns undefined for plain text and malformed skill-like text", () => {
		expect(getSubmittedCommandText("hello", undefined)).toBeUndefined();
		expect(getSubmittedCommandText('<skill name="review">unterminated', undefined)).toBeUndefined();
	});
});
