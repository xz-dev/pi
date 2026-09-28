import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("Slow hook TUI notice (tmux integration)", () => {
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

	it("shows a slow-hook notice when slowHookThresholdMs >= 0 and hides it when disabled", () => {
		if (run("tmux", ["-V"]).status !== 0) {
			throw new Error("tmux is required for this integration regression test");
		}

		const tempDir = mkdtempSync(join(tmpdir(), "pi-slow-hook-tmux-"));
		tempDirs.push(tempDir);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ slowHookThresholdMs: 0 }));

		const slowExtension = join(tempDir, "slow-input.ts");
		const providerExtension = join(tempDir, "test-provider.ts");
		writeFileSync(
			slowExtension,
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function slowInput(pi: ExtensionAPI): void {
\tpi.on("input", async () => {
\t\tawait new Promise((resolve) => setTimeout(resolve, 200));
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

		const runCase = (label: string, settings: object, expectNotice: boolean): string => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
			const session = `pi-slow-hook-${label}-${process.pid}-${Date.now()}`;
			sessions.push(session);
			const command = [
				`PI_CODING_AGENT_DIR=${JSON.stringify(agentDir)}`,
				"./pi-test.sh",
				"--no-env",
				"--no-extensions",
				"-e",
				JSON.stringify(slowExtension),
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
			].join(" ");

			mustRun("tmux", ["new-session", "-d", "-s", session, "-x", "100", "-y", "32", command], { cwd: repoRoot });
			// Wait until startup fully finishes (banner says "Startup is still in
			// progress" while extensions load); then submit a prompt. The positional
			// arg only pre-fills the editor in interactive mode; it does not submit.
			waitFor(
				session,
				(output) => output.includes("panic-test-model") && !output.includes("Startup is still in progress"),
				`startup (${label})`,
			);
			mustRun("tmux", ["send-keys", "-t", session, "hello"]);
			sleep(100);
			mustRun("tmux", ["send-keys", "-t", session, "Enter"]);
			const predicate = expectNotice
				? (output: string) => output.includes("Slow async extension hook:")
				: (output: string) => output.includes("ok") && !output.includes("Working");
			waitFor(session, predicate, `slow-hook notice (${label})`);
			mustRun("tmux", ["send-keys", "-t", session, "Escape"]);
			sleep(300);
			return capture(session);
		};

		const enabled = runCase("on", { slowHookThresholdMs: 0 }, true);
		expect(enabled).toContain("Slow async extension hook:");
		expect(enabled).toContain("slow-input.ts#0");
		expect(enabled).toContain("input");
		expect(enabled).toMatch(/\d+ ms/);

		const disabled = runCase("off", {}, false);
		expect(disabled).not.toContain("Slow async extension hook:");
	});
});
