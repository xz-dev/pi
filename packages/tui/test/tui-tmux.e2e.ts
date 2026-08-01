import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

// This opt-in test covers the real Linux PTY/tmux parser, attached-client output, and ProcessTerminal lifecycle.
// It intentionally does not simulate paced relays, SSH, network backpressure, or transport latency.
const ENABLED = process.platform === "linux" && process.env.PI_TUI_TMUX_E2E === "1";
const POLL_TIMEOUT_MS = 4_000;
const POLL_INTERVAL_MS = 50;
const STABLE_SAMPLES = 3;
const TYPED_TEXT = "cursor target text";
const LOADER_INTERVAL_MS = 80;
const ATTACHED_OBSERVATION_MS = 1_200;
const MINIMUM_EFFICIENT_SYNC_VERSION = [3, 8] as const;
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

type AttachedClientMetrics = {
	bytes: number;
	cursorHides: number;
	cursorShows: number;
	lineErases: number;
};

function attachedClientMetrics(output: Buffer): AttachedClientMetrics {
	const text = output.toString("latin1");
	return {
		bytes: output.byteLength,
		cursorHides: text.match(/\x1b\[\?25l/g)?.length ?? 0,
		cursorShows: text.match(/\x1b\[\?25h/g)?.length ?? 0,
		lineErases: text.match(/\x1b\[[0-9;]*K/g)?.length ?? 0,
	};
}

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

async function tmuxVersion(): Promise<{ display: string; supportsEfficientSynchronizedUpdates: boolean } | undefined> {
	try {
		const { stdout } = await run("tmux", ["-V"]);
		const display = stdout.trim();
		const match = display.match(/(?:next-)?(\d+)\.(\d+)/);
		if (!match) return { display, supportsEfficientSynchronizedUpdates: false };
		const major = Number(match[1]);
		const minor = Number(match[2]);
		const [minimumMajor, minimumMinor] = MINIMUM_EFFICIENT_SYNC_VERSION;
		return {
			display,
			supportsEfficientSynchronizedUpdates:
				major > minimumMajor || (major === minimumMajor && minor >= minimumMinor),
		};
	} catch {
		return undefined;
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
	const version = await tmuxVersion();
	if (!version) {
		context.skip("tmux is not available");
		return;
	}

	const tempDir = await mkdtemp(join(tmpdir(), "pi-tui-tmux-"));
	const socketPath = resolve(tempDir, "tmux.sock");
	const checkpointPath = resolve(tempDir, "checkpoints.txt");
	const target = "cursor-e2e:0.0";
	const attachedOutput: Buffer[] = [];
	let attachedOutputBytes = 0;
	let attachedClient: ReturnType<typeof spawn> | undefined;
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
		await tmux(["set-option", "-as", "terminal-features", ",tmux-256color:sync"]);

		const attachCommand = `exec tmux -S ${socketPath} -f /dev/null attach-session -t cursor-e2e`;
		attachedClient = spawn("script", ["-qefc", attachCommand, "/dev/null"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, TERM: "tmux-256color" },
		});
		const attachedClientError = new Promise<never>((_, reject) => attachedClient?.once("error", reject));
		attachedClient.stdout?.on("data", (chunk: Buffer) => {
			attachedOutput.push(chunk);
			attachedOutputBytes += chunk.byteLength;
		});
		void attachedClientError.catch(() => undefined);
		await Promise.race([
			poll(
				"real tmux client attached over a PTY",
				async () =>
					Number((await tmux(["display-message", "-p", "-t", target, "#{session_attached}"])).stdout.trim()),
				(attached) => attached === 1,
			),
			attachedClientError,
		]);

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

		const observationStart = attachedOutputBytes;
		const startedAt = Date.now();
		await new Promise<void>((resolveObservation) => setTimeout(resolveObservation, ATTACHED_OBSERVATION_MS));
		const elapsedMs = Date.now() - startedAt;
		const observation = Buffer.concat(attachedOutput).subarray(observationStart);
		const metrics = attachedClientMetrics(observation);
		assert.ok(metrics.bytes > 0, "attached tmux client must receive loader updates");
		if (version.supportsEfficientSynchronizedUpdates) {
			const byteBudget = (Math.ceil(elapsedMs / LOADER_INTERVAL_MS) + 2) * 256;
			assert.ok(
				metrics.bytes <= byteBudget,
				`static editor loader updates repainted an excessive attached-client area: ${JSON.stringify({ tmux: version.display, elapsedMs, byteBudget, ...metrics })}`,
			);
			assert.ok(
				metrics.cursorHides <= 2 && metrics.cursorShows <= 2,
				`static editor loader updates repeatedly toggled the attached-client cursor: ${JSON.stringify({ tmux: version.display, elapsedMs, ...metrics })}`,
			);
		} else {
			context.diagnostic(
				`Skipping synchronized-update output budgets on ${version.display}; tmux 3.8 contains the required redraw fixes`,
			);
		}

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
		if (attachedClient && attachedClient.exitCode === null && attachedClient.signalCode === null) {
			attachedClient.kill("SIGKILL");
			await Promise.race([
				new Promise<void>((resolveExit) => attachedClient?.once("close", () => resolveExit())),
				new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
			]);
		}
		await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
}

test(
	"ProcessTerminal keeps the real tmux cursor synchronized through edit, resize, and submit",
	{ timeout: 25_000 },
	main,
);
