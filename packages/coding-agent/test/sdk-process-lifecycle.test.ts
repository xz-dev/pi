// Actual SDK lifecycle regressions using Node socket peers or capture-only shell operations.
import childProcess from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { sessionProcessRegistries } from "../src/core/process-ownership.ts";
import type { OwnedTaskProvenance } from "../src/core/process-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createPowerShellToolDefinition } from "../src/core/tools/powershell.ts";
import * as shell from "../src/utils/shell.ts";
import { createHarness } from "./suite/harness.ts";

let directory: string;
const sessions: AgentSession[] = [];
const children: childProcess.ChildProcess[] = [];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-session-lifecycle-"));
	vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", undefined);
});

afterEach(async () => {
	for (const name of ["start", "primary", "cleanup", "exit"]) writeFileSync(join(directory, name), "");
	await Promise.all(sessions.splice(0).map((s) => s.dispose()));
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function events(): string[] {
	const path = join(directory, "events");
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

function delayedPeer(mode: string) {
	const helper = join(directory, "protocol-peer");
	// The peer never runs the supplied payload. File gates make startup, transcript and process exit independent.
	writeFileSync(
		helper,
		`#!${process.execPath}
const { Socket } = require("node:net");
const { existsSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const root = ${JSON.stringify(directory)};
const mode = ${JSON.stringify(mode)};
const gate = name => existsSync(join(root, name));
const event = name => appendFileSync(join(root, "events"), name + "\\n");
const control = new Socket({fd: 3, readable: true, writable: true});
control.on("error", () => {});
let cancelled = false, started = false, primary = false, ended = false;
control.on("data", data => { if (data.toString().includes("PROCWARD/1 CANCEL\\n")) {cancelled = true; event("cancel");} });
control.on("end", () => {});
event("spawned");
const timer = setInterval(() => {
 if (!started && gate("start")) {
  started = true;
  if (mode === "startup-failure") {control.end("PROCWARD/1 E 125\\n"); process.stdout.end(); process.stderr.end(); ended = true; event("eof");}
  else {control.write("PROCWARD/1 S " + process.pid + " kernel\\n"); event("S");}
 }
 if (cancelled && started && !ended && !primary && gate("primary")) {primary = true; control.write("PROCWARD/1 X 143\\n"); event("X");}
 if (primary && !ended && gate("cleanup")) {ended = true; control.end(mode === "unconfirmed" ? "" : "PROCWARD/1 C kernel\\n"); process.stdout.end(); process.stderr.end(); event("eof");}
 if (ended && gate("exit")) {clearInterval(timer); process.exit(0);}
}, 5);
`,
	);
	chmodSync(helper, 0o755);
	vi.stubEnv("PI_PROCWARD_BIN", helper);
	return helper;
}

describe("SDK disposal during owned startup", () => {
	test.each(["confirmed", "startup-failure", "unconfirmed"])(
		"waits for %s startup cancellation and peer exit",
		async (mode) => {
			const helper = delayedPeer(mode);
			const harness = await createHarness();
			const spawned = Promise.withResolvers<childProcess.ChildProcess>();
			const transportEnded = Promise.withResolvers<void>();
			const transportClosed = Promise.withResolvers<void>();
			const stdoutEnded = Promise.withResolvers<void>();
			const stderrEnded = Promise.withResolvers<void>();
			const originalSpawn = childProcess.spawn;
			let disposal: Promise<void> | undefined;
			let disposed = false;
			try {
				const { session } = await createAgentSession({
					cwd: directory,
					agentDir: join(directory, "agent"),
					sessionManager: SessionManager.inMemory(directory),
					model: harness.getModel(),
					modelRuntime: harness.session.modelRuntime,
				});
				sessions.push(session);
				vi.spyOn(childProcess, "spawn").mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
					const child = originalSpawn(...args);
					if (args[0] === helper) {
						children.push(child);
						child.stdio[3]?.once("end", transportEnded.resolve);
						child.stdio[3]?.once("close", transportClosed.resolve);
						child.stdout?.once("end", stdoutEnded.resolve);
						child.stderr?.once("end", stderrEnded.resolve);
						child.once("spawn", () => {
							disposal = session.dispose().then(() => {
								disposed = true;
							});
							spawned.resolve(child);
						});
					}
					return child;
				});
				syncBuiltinESMExports();
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("bash", { command: "never executed" }, { id: "startup-call" })),
				]);
				const prompt = session.prompt("Start the owned service");
				const child = await spawned.promise;
				await expect.poll(() => events()).toContain("spawned");
				await setImmediate();
				const beforeS = disposed;
				writeFileSync(join(directory, "start"), "");
				await expect.poll(() => events()).toContain(mode === "startup-failure" ? "eof" : "S");
				if (mode !== "startup-failure") {
					await expect.poll(() => events()).toContain("cancel");
					writeFileSync(join(directory, "primary"), "");
					await expect.poll(() => events()).toContain("X");
				}
				const beforeCleanup = disposed;
				writeFileSync(join(directory, "cleanup"), "");
				await expect.poll(() => events()).toContain("eof");
				await (mode === "startup-failure" ? transportClosed.promise : transportEnded.promise);
				// A primary-startup error stops the tool's data listeners; drain the fixture's ended pipes.
				child.stdout?.resume();
				child.stderr?.resume();
				await Promise.all([stdoutEnded.promise, stderrEnded.promise]);
				await setImmediate();
				const beforeExit = disposed;
				expect(child.exitCode).toBeNull();
				writeFileSync(join(directory, "exit"), "");
				await disposal;
				await prompt;
				expect({ beforeS, beforeCleanup, beforeExit }).toEqual({
					beforeS: false,
					beforeCleanup: false,
					beforeExit: false,
				});
				expect(child.exitCode).toBe(0);
				expect(events()).toContain("eof");
			} finally {
				for (const name of ["start", "primary", "cleanup", "exit"]) writeFileSync(join(directory, name), "");
				await disposal;
				for (const child of children) {
					if (child.exitCode === null && child.signalCode === null)
						await new Promise<void>((resolve) => child.once("close", () => resolve()));
				}
				harness.cleanup();
			}
		},
	);
});

describe("prepared built-in native lifetimes", () => {
	test.each(["bash", "powershell", "user_bash"])(
		"dispose drains %s before S without an active agent run",
		async (name) => {
			delayedPeer("confirmed");
			vi.spyOn(shell, "getPowerShellConfig").mockReturnValue({ shell: "pwsh", args: ["-Command"] });
			const harness = await createHarness();
			let execution: Promise<unknown> | undefined;
			let disposal: Promise<void> | undefined;
			try {
				const { session } = await createAgentSession({
					cwd: directory,
					agentDir: join(directory, "agent"),
					sessionManager: SessionManager.inMemory(directory),
					model: harness.getModel(),
					modelRuntime: harness.session.modelRuntime,
					tools: name === "user_bash" ? [] : [name],
				});
				sessions.push(session);
				const tool = session.agent.state.tools.find((tool) => tool.name === name);
				const registry = sessionProcessRegistries.get(session.sessionManager)!;
				execution = (
					name === "user_bash"
						? session.executeBash("never executed")
						: tool!.execute("pre-S", { command: "never executed" })
				).catch((error) => error);
				await expect.poll(() => events()).toContain("spawned");
				expect(registry.list()).toEqual([]);
				let disposed = false;
				disposal = session.dispose().then(() => {
					disposed = true;
				});
				await expect.poll(() => events()).toContain("cancel");
				expect(disposed).toBe(false);
				if (name === "user_bash") {
					await expect(session.executeBash("not admitted")).rejects.toThrow("shutting down");
				} else {
					await expect(tool!.execute("late", { command: "not admitted" })).rejects.toThrow("stale");
				}
				writeFileSync(join(directory, "start"), "");
				await expect.poll(() => registry.list()).toMatchObject([{ status: "reaping" }]);
				writeFileSync(join(directory, "primary"), "");
				await expect.poll(() => events()).toContain("X");
				expect(disposed).toBe(false);
				writeFileSync(join(directory, "cleanup"), "");
				await expect.poll(() => events()).toContain("eof");
				expect(disposed).toBe(false);
				writeFileSync(join(directory, "exit"), "");
				await disposal;
				await execution;
				expect(registry.list()).toEqual([]);
			} finally {
				for (const name of ["start", "primary", "cleanup", "exit"]) writeFileSync(join(directory, name), "");
				await disposal;
				await execution;
				harness.cleanup();
			}
		},
	);
});

describe("shell triggering-turn provenance", () => {
	test.each([
		{ name: "bash", later: false },
		{ name: "bash", later: true },
		{ name: "powershell", later: false },
		{ name: "powershell", later: true },
	] as const)("$name records the custom scheduler turn (later additions: $later)", async ({ name, later }) => {
		const harness = await createHarness();
		const captured = Promise.withResolvers<OwnedTaskProvenance | undefined>();
		const release = Promise.withResolvers<void>();
		const factory = name === "bash" ? createBashToolDefinition : createPowerShellToolDefinition;
		const definition = factory(directory, {
			operations: {
				exec: async (_command, _cwd, options) => {
					captured.resolve(options.provenance);
					await release.promise;
					return { exitCode: 0 };
				},
			},
		});
		let pending: Promise<void> | undefined;
		try {
			const { session } = await createAgentSession({
				cwd: directory,
				agentDir: join(directory, "agent"),
				sessionManager: SessionManager.inMemory(directory),
				model: harness.getModel(),
				modelRuntime: harness.session.modelRuntime,
				// The SDK's unparameterized slot erases renderer argument types; this test renders nothing.
				customTools: [{ ...definition, renderCall: undefined, renderResult: undefined }],
				tools: [name],
			});
			sessions.push(session);
			harness.setResponses([
				fauxAssistantMessage("earlier done"),
				fauxAssistantMessage(fauxToolCall(name, { command: "capture only" }, { id: "custom-trigger-command" })),
				fauxAssistantMessage("scheduled"),
			]);
			await session.prompt("Earlier unrelated user request");
			const earlier = session.sessionManager
				.getBranch()
				.findLast((entry) => entry.type === "message" && entry.message.role === "user")?.id;
			session.subscribe((event) => {
				if (later && event.type === "tool_execution_start")
					session.sessionManager.appendMessage({
						role: "user",
						content: "Later unrelated addition before execution",
						timestamp: Date.now(),
					});
			});
			pending = session.sendCustomMessage(
				{ customType: "scheduler", content: "Start current scheduled service", display: true },
				{ triggerTurn: true },
			);
			const provenance = await captured.promise;
			const trigger = session.sessionManager
				.getBranch()
				.findLast((entry) => entry.type === "custom_message" && entry.customType === "scheduler");
			session.sessionManager.appendCustomMessageEntry("later", "Later unrelated context", false);
			release.resolve();
			await pending;
			expect(earlier).toBeTruthy();
			expect(trigger).toMatchObject({
				type: "custom_message",
				customType: "scheduler",
				content: "Start current scheduled service",
			});
			expect(trigger?.id).not.toBe(earlier);
			expect(provenance).toEqual({
				toolName: name,
				toolCallId: "custom-trigger-command",
				messageId: trigger?.id,
				messageSummary: "Start current scheduled service",
			});
		} finally {
			release.resolve();
			await pending;
			harness.cleanup();
		}
	});
});

test("native disposal does not wait for an unrelated JavaScript tool that ignores abort", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const harness = await createHarness({
		extensionFactories: [
			{
				name: "ignores-abort",
				factory: (pi) => {
					pi.registerTool({
						name: "ignores_abort",
						label: "test",
						description: "Controlled JavaScript tool",
						parameters: Type.Object({}),
						async execute() {
							entered.resolve();
							await release.promise;
							return { content: [{ type: "text", text: "released" }], details: undefined };
						},
					});
				},
			},
		],
	});
	let prompt: Promise<void> | undefined;
	try {
		harness.setResponses([fauxAssistantMessage(fauxToolCall("ignores_abort", {}))]);
		prompt = harness.session.prompt("start controlled tool");
		await entered.promise;
		let disposed = false;
		const disposal = harness.session.dispose().then(() => {
			disposed = true;
		});
		await setImmediate();
		expect(disposed).toBe(true);
		await disposal;
	} finally {
		release.resolve();
		await prompt;
		await harness.session.dispose();
		harness.cleanup();
	}
});

test.each(["enabled", "opt-out"])("custom BashOperations ignoring abort cannot block %s disposal", async (mode) => {
	if (mode === "opt-out") vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", "1");
	const entered = Promise.withResolvers<AbortSignal | undefined>();
	const release = Promise.withResolvers<void>();
	const harness = await createHarness();
	let execution: Promise<unknown> | undefined;
	let disposal: Promise<void> | undefined;
	try {
		execution = harness.session.executeBash("custom non-native operation", undefined, {
			operations: {
				exec: async (_command, _cwd, options) => {
					entered.resolve(options.signal);
					await release.promise;
					return { exitCode: 0 };
				},
			},
		});
		const signal = await entered.promise;
		vi.spyOn(harness.session, "abortRetry").mockImplementation(() => {
			throw new Error("abort hook failed");
		});
		let disposed = false;
		disposal = harness.session.dispose().then(() => {
			disposed = true;
		});
		expect(signal?.aborted).toBe(true);
		await setImmediate();
		expect(disposed).toBe(true);
		await disposal;
	} finally {
		release.resolve();
		await execution;
		await disposal;
		await harness.session.dispose();
		harness.cleanup();
	}
});
