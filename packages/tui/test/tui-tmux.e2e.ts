import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

// This opt-in test covers the real Linux PTY/tmux parser and ProcessTerminal lifecycle only.
// It intentionally does not simulate paced relays, SSH, network backpressure, or transport latency.
const ENABLED = process.platform === "linux" && process.env.PI_TUI_TMUX_E2E === "1";
const POLL_TIMEOUT_MS = 4_000;
const POLL_INTERVAL_MS = 50;
const STABLE_SAMPLES = 3;
const TYPED_TEXT = "cursor target text";
const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/synchronized-cursor-tmux-fixture.ts", import.meta.url));

type CommandResult = {
	stdout: string;
	stderr: string;
};

type PaneState = {
	width: number;
	height: number;
	cursorX: number;
	cursorY: number;
	dead: boolean;
	pane: string;
};

function run(command: string, args: string[], timeoutMs = POLL_TIMEOUT_MS): Promise<CommandResult> {
	return new Promise((resolveCommand, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${command} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) {
				resolveCommand({ stdout, stderr });
				return;
			}
			reject(new Error(`${command} exited with ${code ?? signal}: ${stderr.trim()}`));
		});
	});
}

async function poll<T>(description: string, inspect: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	let lastValue: T | undefined;
	while (Date.now() < deadline) {
		lastValue = await inspect();
		if (matches(lastValue)) return lastValue;
		await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, POLL_INTERVAL_MS));
	}
	throw new Error(`timed out waiting for ${description}; last value: ${JSON.stringify(lastValue)}`);
}

async function hasTmux(): Promise<boolean> {
	try {
		await run("tmux", ["-V"]);
		return true;
	} catch {
		return false;
	}
}

async function readCheckpoints(path: string): Promise<string[]> {
	try {
		return (await readFile(path, "utf8")).split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

async function main(context: TestContext): Promise<void> {
	if (!ENABLED) {
		context.skip("requires Linux and PI_TUI_TMUX_E2E=1");
		return;
	}
	if (!(await hasTmux())) {
		context.skip("tmux is not available");
		return;
	}

	const tempDir = await mkdtemp(join(tmpdir(), "pi-tui-tmux-"));
	const socketPath = resolve(tempDir, "tmux.sock");
	const checkpointPath = resolve(tempDir, "checkpoints.txt");
	const target = "cursor-e2e:0.0";
	const tmuxArgs = (args: string[]): string[] => ["-S", socketPath, "-f", "/dev/null", ...args];
	const tmux = (args: string[], timeoutMs?: number): Promise<CommandResult> => run("tmux", tmuxArgs(args), timeoutMs);
	const paneState = async (): Promise<PaneState> => {
		const [fields, captured] = await Promise.all([
			tmux([
				"display-message",
				"-p",
				"-t",
				target,
				"#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{pane_dead}",
			]),
			tmux(["capture-pane", "-p", "-e", "-t", target]),
		]);
		const [width, height, cursorX, cursorY, dead] = fields.stdout.trim().split("\t").map(Number);
		return { width, height, cursorX, cursorY, dead: dead === 1, pane: captured.stdout };
	};
	const stablePane = (description: string, matches: (state: PaneState) => boolean): Promise<PaneState> => {
		let previousKey = "";
		let stableCount = 0;
		return poll(description, paneState, (state) => {
			const stablePaneText = state.pane
				.split("\n")
				.map((line) => (line.includes("STATUS_BUSY") ? "STATUS_BUSY" : line))
				.join("\n");
			const key = `${state.width}:${state.height}:${state.cursorX}:${state.cursorY}:${stablePaneText}`;
			stableCount = key === previousKey ? stableCount + 1 : 1;
			previousKey = key;
			return matches(state) && stableCount >= STABLE_SAMPLES;
		});
	};

	try {
		await tmux([
			"new-session",
			"-d",
			"-x",
			"80",
			"-y",
			"24",
			"-s",
			"cursor-e2e",
			process.execPath,
			FIXTURE_PATH,
			checkpointPath,
		]);
		await poll(
			"fixture ready checkpoint",
			() => readCheckpoints(checkpointPath),
			(lines) => lines.includes("ready"),
		);
		await tmux(["set-option", "-t", "cursor-e2e", "remain-on-exit", "on"]);

		await tmux(["send-keys", "-t", target, "-l", TYPED_TEXT]);
		await poll(
			"fixture editor change checkpoint",
			() => readCheckpoints(checkpointPath),
			(lines) => lines.includes(`changed:${TYPED_TEXT}`),
		);

		const edited = await stablePane(
			"typed editor text and committed cursor",
			(state) => state.pane.includes(TYPED_TEXT) && state.cursorX === TYPED_TEXT.length && state.cursorY === 3,
		);
		assert.match(edited.pane, /STATUS_BUSY/);
		assert.equal(edited.cursorY, 3, "hardware cursor should target the editor line");
		assert.notEqual(edited.cursorY, 1, "spinner/status line must not be the hardware cursor target");

		await tmux(["resize-window", "-t", "cursor-e2e:0", "-x", "16", "-y", "12"]);
		const smaller = await stablePane(
			"smaller pane and wrapped editor cursor",
			(state) =>
				state.width === 16 &&
				state.height === 12 &&
				state.pane.includes("cursor target") &&
				state.pane.includes("text") &&
				state.cursorX === 4 &&
				state.cursorY === 4,
		);
		assert.equal(smaller.cursorY, 4);

		await tmux(["resize-window", "-t", "cursor-e2e:0", "-x", "96", "-y", "30"]);
		const larger = await stablePane(
			"larger pane and editor cursor",
			(state) =>
				state.width === 96 &&
				state.height === 30 &&
				state.pane.includes(TYPED_TEXT) &&
				state.cursorX === TYPED_TEXT.length,
		);
		assert.equal(larger.cursorY, 3);

		await tmux(["send-keys", "-t", target, "Enter"]);
		await poll(
			"exact submit and graceful stop checkpoints",
			() => readCheckpoints(checkpointPath),
			(lines) => lines.includes(`submitted:${TYPED_TEXT}`) && lines.includes("stopped:submit"),
		);
		await poll("fixture pane exit", paneState, (state) => state.dead);
	} finally {
		await tmux(["kill-server"]).catch(() => undefined);
		await rm(tempDir, { recursive: true, force: true });
	}
}

test(
	"ProcessTerminal keeps the real tmux cursor synchronized through edit, resize, and submit",
	{ timeout: 25_000 },
	main,
);
