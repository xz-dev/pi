import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

function run(command: string, args: string[], options: { cwd?: string } = {}) {
	return spawnSync(command, args, { encoding: "utf8", ...options });
}

function mustRun(command: string, args: string[], options: { cwd?: string } = {}) {
	const result = run(command, args, options);
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed with ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
		);
	}
	return result;
}

function sleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function capture(session: string): string {
	return run("tmux", ["capture-pane", "-t", session, "-p", "-S", "-2000"]).stdout;
}

function waitFor(session: string, predicate: (output: string) => boolean, label: string): string {
	const start = Date.now();
	let output = "";
	while (Date.now() - start < 15_000) {
		const alive = run("tmux", ["has-session", "-t", session]);
		if (alive.status !== 0) {
			throw new Error(`tmux session exited while waiting for ${label}\nLast output:\n${output}`);
		}
		output = capture(session);
		if (predicate(output)) return output;
		sleep(100);
	}
	throw new Error(`timed out waiting for ${label}\nLast output:\n${output}`);
}

describe("Esc abort stuck extension integration", () => {
	const sessions: string[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const session of sessions.splice(0)) {
			run("tmux", ["kill-session", "-t", session]);
		}
		for (const tempDir of tempDirs.splice(0)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("clears Working after Esc when a context extension hook never settles", () => {
		const tmuxAvailable = run("tmux", ["-V"]);
		if (tmuxAvailable.status !== 0) {
			throw new Error("tmux is required for this integration regression test");
		}

		const tempDir = mkdtempSync(join(tmpdir(), "pi-esc-abort-tmux-"));
		tempDirs.push(tempDir);
		const stuckExtension = join(tempDir, "stuck-context.ts");
		const providerExtension = join(tempDir, "test-provider.ts");
		writeFileSync(
			stuckExtension,
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function stuckContext(pi: ExtensionAPI): void {
\tpi.on("context", async (_event, ctx) => {
\t\tctx.ui.notify("ESC_ABORT_TMUX_STUCK_CONTEXT_STARTED", "warning");
\t\tawait new Promise(() => {});
\t});
}
`,
		);
		writeFileSync(
			providerExtension,
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function message(): AssistantMessage { return { role: "assistant", api: "panic-test", provider: "panic-test", model: "panic-test-model", content: [{ type: "text", text: "ok" }], usage, stopReason: "stop", timestamp: Date.now() }; }
export default function testProvider(pi: ExtensionAPI): void {
\tpi.registerProvider("panic-test", {
\t\tname: "Panic Test",
\t\tbaseUrl: "http://panic-test.local/v1",
\t\tapi: "panic-test",
\t\tapiKey: "key",
\t\tmodels: [{ id: "panic-test-model", name: "Panic Test Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
\t\tstreamSimple: () => {
\t\t\tconst stream = createAssistantMessageEventStream();
\t\t\tqueueMicrotask(() => { const output = message(); stream.push({ type: "start", partial: output }); stream.push({ type: "done", reason: "stop", message: output }); stream.end(output); });
\t\t\treturn stream;
\t\t},
\t});
}
`,
		);

		const session = `pi-esc-abort-${process.pid}-${Date.now()}`;
		sessions.push(session);
		const command = [
			"./pi-test.sh",
			"--no-env",
			"--no-extensions",
			"-e",
			JSON.stringify(stuckExtension),
			"-e",
			JSON.stringify(providerExtension),
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-themes",
			"--no-session",
			"--offline",
			"--no-approve",
			"--provider",
			"panic-test",
			"--model",
			"panic-test-model",
			"hello",
		].join(" ");

		mustRun("tmux", ["new-session", "-d", "-s", session, "-x", "100", "-y", "32", command], { cwd: repoRoot });
		waitFor(session, (output) => output.includes("ESC_ABORT_TMUX_STUCK_CONTEXT_STARTED"), "stuck marker");
		mustRun("tmux", ["send-keys", "-t", session, "Escape"]);
		const abortedOutput = waitFor(session, (output) => output.includes("Operation aborted"), "abort result");
		expect(abortedOutput).not.toContain("Working...");

		mustRun("tmux", ["send-keys", "-t", session, "Escape"]);
		sleep(100);
		mustRun("tmux", ["send-keys", "-t", session, "Escape"]);
		const treeOutput = waitFor(session, (output) => output.includes("Session Tree"), "session tree after abort");
		expect(treeOutput).toContain("assistant: (aborted)");
	}, 30_000);
});
