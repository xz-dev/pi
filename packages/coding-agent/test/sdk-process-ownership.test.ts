import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { McpClient } from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ExecResult } from "../src/core/exec.ts";
import { sessionProcessRegistries } from "../src/core/process-ownership.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import type { ProcessKillResult } from "../src/core/tools/process-kill.ts";
import type { ProcessListEntry } from "../src/core/tools/process-list.ts";
import { createDefaultTransport } from "../src/extensions/mcp/runtime.ts";
import { CONTRACT_ENV_KEYS } from "../src/utils/managed-child.ts";
import { ownCliProcess } from "../src/utils/procward.ts";
import * as shell from "../src/utils/shell.ts";
import { createHarness } from "./suite/harness.ts";

let directory: string;
const sessions: AgentSession[] = [];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-session-owned-"));
	vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", undefined);
	const helper = join(directory, "protocol-peer");
	// This is a Node-only protocol peer: it never runs the supplied shell command.
	writeFileSync(
		helper,
		`#!${process.execPath}
const { Socket } = require("node:net");
const control = new Socket({ fd: 3, readable: true, writable: true });
const marker = process.argv.at(-1);
const incomplete = marker.includes("incomplete");
const mcp = marker.includes("mcp-handshake");
const waiting = marker.includes("wait-cancel");
const mode = process.env.PI_TEST_PEER_MODE;
const handoff = Object.fromEntries(${JSON.stringify([...CONTRACT_ENV_KEYS, "PI_PROCWARD_BOOTSTRAP_NONCE"])}.map(key => [key, process.env[key]]));
if (process.env.PI_TEST_PEER_ENV_FILE) require("node:fs").writeFileSync(process.env.PI_TEST_PEER_ENV_FILE, JSON.stringify(handoff));
if (mode === "fail-before-S") process.exit(17);
let started = false;
let primary = false;
const start = () => { started = true; control.write("PROCWARD/1 S " + process.pid + " kernel\\n"); };
const timer = mode === "no-S" ? undefined : setTimeout(() => {
 start();
 if (!mcp && !waiting) { primary = true; control.write("PROCWARD/1 X 0\\n"); }
}, mode === "delayed-S" ? 500 : mcp ? 50 : 0);
if (mcp) {
 const { createInterface } = require("node:readline");
 createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize"
   ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "peer", version: "1" } }
   : { tools: [] };
  process.stdout.write(JSON.stringify({jsonrpc: "2.0", id: request.id, result}) + "\\n");
 });
} else {
 process.stdout.write("peer stdout\\n");
 process.stderr.write("peer stderr\\n");
 if (marker.includes("env-check")) process.stdout.write(JSON.stringify(handoff) + "\\n");
}
control.on("data", data => {
 if (!data.toString().includes("PROCWARD/1 CANCEL\\n")) return;
 clearTimeout(timer);
 if (mode === "no-S") return control.end(() => process.exit(0));
 if (!started) start();
 if (!primary) control.write("PROCWARD/1 X 0\\n");
 control.end(incomplete ? "" : "PROCWARD/1 C kernel\\n", () => process.exit(0));
});
control.on("end", () => process.exit(0));
`,
	);
	chmodSync(helper, 0o755);
	vi.stubEnv("PI_PROCWARD_BIN", helper);
});

afterEach(async () => {
	await Promise.all(sessions.splice(0).map((session) => session.dispose()));
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

async function session(options: Partial<CreateAgentSessionOptions> = {}) {
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: join(directory, "agent"),
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		sessionManager: SessionManager.inMemory(directory),
		...options,
	});
	sessions.push(session);
	return session;
}

function tool(session: AgentSession, name: string) {
	const tool = session.agent.state.tools.find((item) => item.name === name);
	if (!tool) throw new Error(`Missing tool: ${name}`);
	return tool;
}

function data(result: Awaited<ReturnType<ReturnType<typeof tool>["execute"]>>) {
	const content = result.content.find((part) => part.type === "text");
	if (!content || content.type !== "text") throw new Error("Missing text result");
	return JSON.parse(content.text) as { processes: ProcessListEntry[]; results: ProcessKillResult[] };
}

describe("default session process ownership (Node-only protocol peer)", () => {
	test("default SDK registers management tools and records background provenance", async () => {
		const s = await session();
		expect(s.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "process_list", "process_kill"]));
		const messageId = s.sessionManager.appendMessage({
			role: "user",
			content: "Start the development service",
			timestamp: Date.now(),
		});
		const result = await tool(s, "bash").execute("bash-call-1", { command: "background command" });
		const text = result.content.find((part) => part.type === "text");
		expect(text?.type === "text" ? text.text : "").toContain("peer stdout");
		expect(text?.type === "text" ? text.text : "").toContain("peer stderr");
		const listed = data(await tool(s, "process_list").execute("list-1", {}));
		expect(listed.processes).toHaveLength(1);
		expect(listed.processes[0]).toMatchObject({
			kind: "task",
			status: "background",
			purpose: "bash tool call bash-call-1",
			provenance: {
				toolName: "bash",
				toolCallId: "bash-call-1",
				messageId,
				messageSummary: "Start the development service",
			},
		});
		expect(listed.processes[0].procwardPid).toBeGreaterThan(0);
		// An embedded SDK must never invent a self-owner from process.ppid.
		expect(listed.processes.some((entry) => entry.kind === "session")).toBe(false);
		const killed = data(await tool(s, "process_kill").execute("kill-1", { ids: [listed.processes[0].id, 999] }));
		expect(killed.results).toEqual([
			{ id: listed.processes[0].id, status: "confirmed", exitCode: 0, scope: "kernel", unconfirmed: false },
			{ id: 999, status: "unknown", reason: "Unknown task ID" },
		]);
		expect(data(await tool(s, "process_list").execute("list-2", {})).processes).toEqual([]);
	});

	test("cancelling one background task leaves another intact and reports incomplete cleanup", async () => {
		const s = await session();
		await tool(s, "bash").execute("one", { command: "first" });
		await tool(s, "bash").execute("two", { command: "incomplete" });
		const before = data(await tool(s, "process_list").execute("list", {})).processes;
		const first = data(await tool(s, "process_kill").execute("kill", { ids: [before[0].id] }));
		expect(first.results[0].status).toBe("confirmed");
		expect(data(await tool(s, "process_list").execute("list", {})).processes).toHaveLength(1);
		const second = data(await tool(s, "process_kill").execute("kill", { ids: [before[1].id] }));
		expect(second.results[0]).toMatchObject({ status: "unconfirmed", unconfirmed: true });
		expect(data(await tool(s, "process_list").execute("list", {})).processes[0].status).toBe("unconfirmed");
		await tool(s, "process_kill").execute("retry", { ids: [before[1].id] });
		expect(data(await tool(s, "process_list").execute("list", {})).processes[0].status).toBe("unconfirmed");
	});

	test("a faux model uses the default SDK tools and keeps the triggering message provenance", async () => {
		const harness = await createHarness();
		try {
			const s = await session({ model: harness.getModel(), modelRuntime: harness.session.modelRuntime });
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "background" }, { id: "faux-background" })),
				fauxAssistantMessage(fauxToolCall("process_list", {}, { id: "faux-list" })),
				fauxAssistantMessage("ready"),
			]);
			await s.prompt("Keep the service available");
			const listed = data(await tool(s, "process_list").execute("inspect", {})).processes;
			expect(listed[0].provenance).toMatchObject({
				toolCallId: "faux-background",
				messageSummary: "Keep the service available",
			});
			expect(listed[0].provenance?.messageId).toBeTruthy();
		} finally {
			harness.cleanup();
		}
	});

	test("session disposal waits for native task cancellation evidence", async () => {
		const s = await session();
		await tool(s, "bash").execute("dispose-call", { command: "background" });
		await s.dispose();
		expect(data(await tool(s, "process_list").execute("list", {})).processes).toEqual([]);
	});

	test("shutdown permanently rejects session admissions, including tree hook races", async () => {
		const s = await session();
		const first = s.sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		const last = s.sessionManager.appendMessage({ role: "user", content: "last", timestamp: Date.now() });
		vi.spyOn(s.extensionRunner, "hasHandlers").mockImplementation((type) => type === "session_before_tree");
		vi.spyOn(s.extensionRunner, "emit").mockImplementation(async () => {
			s.prepareForShutdown();
			return undefined;
		});
		await expect(s.navigateTree(first)).rejects.toThrow("shutting down");
		expect(s.sessionManager.getLeafId()).toBe(last);
		await expect(s.navigateTree(last)).rejects.toThrow("shutting down");
		await expect(s.prompt("late")).rejects.toThrow("shutting down");
		await expect(s.steer("late")).rejects.toThrow("shutting down");
		await expect(s.followUp("late")).rejects.toThrow("shutting down");
		await expect(s.sendCustomMessage({ customType: "late", content: "late", display: false })).rejects.toThrow(
			"shutting down",
		);
		await expect(s.compact()).rejects.toThrow("shutting down");
		await expect(s.reload()).rejects.toThrow("shutting down");
		await expect(s.executeBash("late")).rejects.toThrow("shutting down");
	});

	test("opt-out registers no management tools and executes without resolving even an invalid helper", async () => {
		vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", "1");
		vi.stubEnv("PI_PROCWARD_BIN", join(directory, "does-not-exist"));
		const s = await session();
		expect(s.getAllTools().some((item) => item.name.startsWith("process_"))).toBe(false);
		const result = await tool(s, "bash").execute("direct", { command: "printf direct" });
		expect(result.content).toEqual([{ type: "text", text: "direct" }]);
	});

	test("explicit read-only selection and no-tools mode remain exact", async () => {
		const s = await session({ tools: ["read", "grep"] });
		expect(s.getActiveToolNames()).toEqual(["read", "grep"]);
		const empty = await session({ noTools: "all" });
		expect(empty.getActiveToolNames()).toEqual([]);
	});

	test("PowerShell uses the same owned task transport and provenance", async () => {
		vi.spyOn(shell, "getPowerShellConfig").mockReturnValue({ shell: "pwsh", args: ["-Command"] });
		const s = await session({ tools: ["powershell", "process_list", "process_kill"] });
		await tool(s, "powershell").execute("pwsh-call", { command: "Write-Output background" });
		const listed = data(await tool(s, "process_list").execute("list", {})).processes;
		expect(listed).toHaveLength(1);
		expect(listed[0].command).toContain("pwsh -Command");
		expect(listed[0].provenance).toMatchObject({ toolName: "powershell", toolCallId: "pwsh-call" });
	});

	test("a detached managed bash execution stays owned until tool_task cancels it", async (context) => {
		const harness = await createHarness();
		try {
			// Managed executions come from patch/managed-tool-executions, which the distribution composes with this
			// patch. The setting is parsed rather than typed so this branch also compiles without that patch.
			const settingsManager = SettingsManager.inMemory(
				JSON.parse('{"backgroundToolCalls":{"bash":{"detachAfterSeconds":0.2}}}'),
			);
			const s = await session({
				model: harness.getModel(),
				modelRuntime: harness.session.modelRuntime,
				settingsManager,
			});
			if (!("managedExecutions" in s.agent)) return context.skip();
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "wait-cancel" }, { id: "managed-bash" })),
				fauxAssistantMessage("detached"),
			]);
			await s.prompt("Run the long job");
			const running = data(await tool(s, "process_list").execute("list", {})).processes;
			expect(running).toMatchObject([
				{ status: "running", provenance: { toolName: "bash", toolCallId: "managed-bash" } },
			]);
			const tasks = (await tool(s, "tool_task").execute("tasks", { action: "list" })).details as {
				tasks: { id: string }[];
			};
			expect(tasks.tasks).toHaveLength(1);
			await tool(s, "tool_task").execute("cancel", { action: "cancel", id: tasks.tasks[0].id });
			// The managed abort reaches the owner as CANCEL; the entry leaves only after confirmed cleanup.
			await vi.waitFor(async () => {
				expect(data(await tool(s, "process_list").execute("after", {})).processes).toEqual([]);
			});
		} finally {
			harness.cleanup();
		}
	});

	test("user_bash preserves foreground output and tracks the triggering user command", async () => {
		const s = await session();
		const unrelatedId = s.sessionManager.appendMessage({
			role: "user",
			content: "Run a service",
			timestamp: Date.now(),
		});
		const chunks: string[] = [];
		const result = await s.executeBash("background command", (chunk) => chunks.push(chunk), { id: "user-command-1" });
		expect(result).toMatchObject({ output: expect.stringContaining("peer stdout"), exitCode: 0, cancelled: false });
		expect(chunks.join("")).toBe(result.output);
		const message = s.sessionManager
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "bashExecution" &&
					entry.message.command === "background command",
			);
		expect(message?.id).not.toBe(unrelatedId);
		const messageId = message?.id;
		expect(messageId).toBeTruthy();
		const listed = data(await tool(s, "process_list").execute("list", {})).processes;
		expect(listed[0]).toMatchObject({
			status: "background",
			provenance: {
				toolName: "user_bash",
				toolCallId: "user-command-1",
				messageId,
				messageSummary: "background command",
			},
		});
		expect(data(await tool(s, "process_kill").execute("kill", { ids: [listed[0].id] })).results[0].status).toBe(
			"confirmed",
		);
	});

	test("concurrent user_bash executions link only to their own persisted command entries", async () => {
		const s = await session();
		const unrelated = s.sessionManager.appendMessage({
			role: "user",
			content: "Unrelated earlier message",
			timestamp: Date.now(),
		});
		await Promise.all([
			s.executeBash("one", undefined, { id: "one" }),
			s.executeBash("two", undefined, { id: "two" }),
		]);
		const entries = s.sessionManager.getBranch();
		for (const task of sessionProcessRegistries.get(s.sessionManager)!.list()) {
			const provenance = task.provenance!;
			expect(provenance.messageId).not.toBe(unrelated);
			const entry = entries.find((entry) => entry.id === provenance.messageId);
			expect(entry).toMatchObject({
				type: "message",
				message: { role: "bashExecution", command: provenance.toolCallId },
			});
		}
	});

	test("running and deferred user_bash executions do not claim an unrelated message", async () => {
		const s = await session();
		s.sessionManager.appendMessage({ role: "user", content: "Unrelated earlier message", timestamp: Date.now() });
		const execution = s.executeBash("wait-cancel", undefined, { id: "pending-user" });
		const registry = sessionProcessRegistries.get(s.sessionManager)!;
		await vi.waitFor(() => expect(registry.list()).toHaveLength(1));
		expect(registry.list()[0].provenance?.messageId).toBeUndefined();
		s.abortBash();
		await execution;
		vi.spyOn(s, "isStreaming", "get").mockReturnValue(true);
		await s.executeBash("deferred", undefined, { id: "deferred-user" });
		expect(registry.list()[0].provenance).toMatchObject({ toolCallId: "deferred-user" });
		expect(registry.list()[0].provenance?.messageId).toBeUndefined();
		expect(
			s.sessionManager
				.getBranch()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "bashExecution" &&
						entry.message.command === "deferred",
				),
		).toBe(false);
	});

	test("user_bash custom operations receive provenance and cancellation without local spawning", async () => {
		const s = await session();
		const exec = vi.fn<BashOperations["exec"]>(async (_command, _cwd, options) => {
			options.onData(Buffer.from("captured"));
			return { exitCode: 7 };
		});
		const result = await s.executeBash("remote command", undefined, { id: "remote", operations: { exec } });
		expect(result).toMatchObject({ output: "captured", exitCode: 7 });
		expect(exec.mock.calls[0][2]).toMatchObject({
			signal: expect.any(AbortSignal),
			provenance: { toolName: "user_bash", toolCallId: "remote" },
		});
		expect(data(await tool(s, "process_list").execute("list", {})).processes).toEqual([]);
	});

	test("MCP handshake is unchanged and slow S registration keeps server/config provenance", async () => {
		const s = await session();
		const registry = sessionProcessRegistries.get(s.sessionManager);
		const transport = createDefaultTransport(
			{ name: "faux", source: "/test/mcp.json", config: { command: "never-run", args: ["mcp-handshake"] } },
			directory,
			undefined,
			registry,
		);
		const client = new McpClient({ name: "test", version: "1" });
		try {
			const initialized = await client.connect(transport);
			expect(initialized.serverInfo.name).toBe("peer");
			expect(await client.listTools()).toEqual([]);
			await vi.waitFor(() => expect(registry?.list()).toHaveLength(1));
			expect(registry?.list()[0]).toMatchObject({
				status: "running",
				provenance: { toolName: "mcp_server", serverName: "faux", configSource: "/test/mcp.json" },
			});
		} finally {
			await client.close();
		}
		expect(registry?.list()).toEqual([]);
	});

	test("pi.exec uses the bound session registry and extension provenance", async () => {
		let executed: ExecResult | undefined;
		const harness = await createHarness({
			extensionFactories: [
				{
					name: "managed-seam",
					factory: (pi) => {
						pi.registerTool({
							name: "managed_stub",
							label: "managed",
							description: "Run an extension process",
							parameters: Type.Object({}),
							async execute() {
								executed = await pi.exec("never-run", ["background"]);
								return { content: [{ type: "text", text: executed.stdout }], details: undefined };
							},
						});
					},
				},
			],
		});
		try {
			harness.setResponses([fauxAssistantMessage(fauxToolCall("managed_stub", {})), fauxAssistantMessage("done")]);
			await harness.session.prompt("Run the extension");
			expect(executed).toMatchObject({ stdout: "peer stdout\n", stderr: "peer stderr\n", code: 0, killed: false });
			const entries = data(await tool(harness.session, "process_list").execute("list", {})).processes;
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({
				status: "background",
				provenance: { toolName: "pi.exec", extensionPath: "<inline:managed-seam>" },
			});
			await harness.session.dispose();
			expect(data(await tool(harness.session, "process_list").execute("list", {})).processes).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	test("owned user_bash strips all inherited handoff fields", async () => {
		const s = await session();
		for (const key of CONTRACT_ENV_KEYS) vi.stubEnv(key, "private-parent-handoff");
		vi.stubEnv("PI_PROCWARD_BOOTSTRAP_NONCE", "private-parent-nonce");
		const result = await s.executeBash("env-check");
		const env = JSON.parse(result.output.split("\n").find((line) => line.startsWith("{"))!) as NodeJS.ProcessEnv;
		for (const key of [...CONTRACT_ENV_KEYS, "PI_PROCWARD_BOOTSTRAP_NONCE"]) expect(env[key]).toBeUndefined();
	});

	test("user_bash disposal aborts a foreground task and waits for its transcript", async () => {
		const s = await session();
		const execution = s.executeBash("wait-cancel");
		await vi.waitFor(() => expect(sessionProcessRegistries.get(s.sessionManager)?.list()).toHaveLength(1));
		await s.dispose();
		expect(await execution).toMatchObject({ cancelled: true, exitCode: undefined });
		expect(sessionProcessRegistries.get(s.sessionManager)?.list()).toEqual([]);
		await expect(s.executeBash("after close")).rejects.toThrow("shutting down");
	});

	test.each(["user_bash", "mcp", "pi.exec"] as const)(
		"%s cleans pending delayed-S/no-S/failed starts and strips parent contracts",
		async (seam) => {
			for (const mode of ["delayed-S", "no-S", "fail-before-S"]) {
				let run: (() => Promise<ExecResult>) | undefined;
				const harness = await createHarness({
					extensionFactories: [
						{
							name: "pending-exec",
							factory: (pi) => {
								run = () => pi.exec("never-run", ["wait-cancel"]);
							},
						},
					],
				});
				const s = harness.session;
				const envFile = join(directory, `${seam}-${mode}.json`);
				vi.stubEnv("PI_TEST_PEER_MODE", mode);
				vi.stubEnv("PI_TEST_PEER_ENV_FILE", envFile);
				for (const key of CONTRACT_ENV_KEYS) vi.stubEnv(key, "private-parent-handoff");
				vi.stubEnv("PI_PROCWARD_BOOTSTRAP_NONCE", "private-parent-nonce");
				const transport =
					seam === "mcp"
						? createDefaultTransport(
								{
									name: "pending",
									source: "/test/pending.json",
									config: {
										command: "never-run",
										args: ["mcp-handshake"],
										env: Object.fromEntries(CONTRACT_ENV_KEYS.map((key) => [key, "config-handoff"])),
									},
								},
								directory,
								undefined,
								sessionProcessRegistries.get(s.sessionManager),
							)
						: undefined;
				try {
					if (!run) throw new Error("Missing extension exec");
					const execution = transport
						? transport.start()
						: seam === "user_bash"
							? s.executeBash("wait-cancel")
							: run();
					const outcome = execution.then(
						() => "completed",
						(error) => String(error),
					);
					await vi.waitFor(() => expect(existsSync(envFile)).toBe(true));
					const env = JSON.parse(readFileSync(envFile, "utf8")) as NodeJS.ProcessEnv;
					for (const key of [...CONTRACT_ENV_KEYS, "PI_PROCWARD_BOOTSTRAP_NONCE"])
						expect(env[key]).toBeUndefined();
					expect(sessionProcessRegistries.get(s.sessionManager)?.list()).toEqual([]);
					await s.dispose();
					const result = await outcome;
					expect(result === "completed" || result.includes("without a primary result")).toBe(true);
					expect(sessionProcessRegistries.get(s.sessionManager)?.list()).toEqual([]);
					expect(run).toThrow("stale");
				} finally {
					await transport?.close();
					await s.dispose();
					harness.cleanup();
				}
			}
		},
	);

	test("pi.exec AbortSignal sends owner cancellation without direct signals", async () => {
		let run: ((signal: AbortSignal) => Promise<ExecResult>) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				{
					name: "cancel-exec",
					factory: (pi) => {
						run = (signal) => pi.exec("never-run", ["wait-cancel"], { signal });
					},
				},
			],
		});
		try {
			if (!run) throw new Error("Missing extension exec");
			const abort = new AbortController();
			const execution = run(abort.signal);
			await vi.waitFor(() =>
				expect(sessionProcessRegistries.get(harness.session.sessionManager)?.list()).toHaveLength(1),
			);
			abort.abort();
			expect(await execution).toMatchObject({ killed: true });
			expect(sessionProcessRegistries.get(harness.session.sessionManager)?.list()).toEqual([]);
		} finally {
			await harness.session.dispose();
			harness.cleanup();
		}
	});

	test("opt-out user_bash and bound pi.exec preserve direct execution and parent environment", async () => {
		vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", "1");
		vi.stubEnv("PI_PROCWARD_BIN", join(directory, "missing-helper"));
		vi.stubEnv("PI_PROCWARD_BOOTSTRAP_NONCE", "legacy-nonce");
		const s = await session();
		expect(
			await s.executeBash(
				`"${process.execPath}" -e 'process.stdout.write(process.env.PI_PROCWARD_BOOTSTRAP_NONCE)'`,
			),
		).toMatchObject({ output: "legacy-nonce", exitCode: 0 });
		let run: (() => Promise<ExecResult>) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				{
					name: "optout-exec",
					factory: (pi) => {
						run = () =>
							pi.exec(process.execPath, ["-e", "process.stdout.write(process.env.PI_PROCWARD_BOOTSTRAP_NONCE)"]);
					},
				},
			],
		});
		try {
			if (!run) throw new Error("Missing extension exec");
			expect(await run()).toEqual({ stdout: "legacy-nonce", stderr: "", code: 0, killed: false, truncated: false });
			expect(harness.session.getAllTools().some((tool) => tool.name.startsWith("process_"))).toBe(false);
		} finally {
			await harness.session.dispose();
			harness.cleanup();
		}
	});

	test("invocation-local opt-out hides tools without disabling nested invocations through env", async () => {
		ownCliProcess(["--no-process-ownership"], {
			resolveBinary: () => {
				throw new Error("opt-out resolved helper");
			},
		});
		vi.stubEnv("PI_PROCWARD_BIN", join(directory, "missing"));
		const s = await session();
		expect(s.getAllTools().some((item) => item.name.startsWith("process_"))).toBe(false);
		const result = await tool(s, "bash").execute("local-optout", {
			command: `"${process.execPath}" -e 'process.stdout.write(process.env.PI_NO_PROCESS_OWNERSHIP || "unset")'`,
		});
		expect(result.content).toEqual([{ type: "text", text: "unset" }]);
	});

	test("a validated session owner is visible but cannot be cancelled", async () => {
		const ownerPid = process.ppid;
		vi.stubEnv("PI_PROCWARD_BOOTSTRAP_NONCE", "a".repeat(32));
		vi.stubEnv("PROCWARD_PROTOCOL", "1");
		vi.stubEnv("PROCWARD_OWNER_PID", String(ownerPid));
		ownCliProcess([], {
			resolveBinary: () => {
				throw new Error("own handoff must not resolve helper");
			},
			consumeContract: () => ({ ownerPid, launchId: "b".repeat(32), lifecycleFd: 4 }),
			observeLoss: () => ({ stop() {}, observedAt: undefined }),
		});
		const s = await session();
		const listed = data(await tool(s, "process_list").execute("self", {})).processes;
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ id: 0, kind: "session", procwardPid: ownerPid });
		const result = data(await tool(s, "process_kill").execute("self", { ids: [0] }));
		expect(result.results[0]).toMatchObject({ id: 0, status: "not-cancellable" });
	});
});
