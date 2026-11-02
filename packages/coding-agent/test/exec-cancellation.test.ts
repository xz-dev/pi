import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ExecOptions, type ExecResult, execCommand } from "../src/core/exec.ts";

// Regression coverage for https://github.com/earendil-works/pi/issues/7864.
let directory: string;
let pending: Promise<ExecResult>[];

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function execute(args: string[], options?: ExecOptions): Promise<ExecResult> {
	const result = execCommand(process.execPath, args, process.cwd(), options);
	pending.push(result);
	return withTimeout(result, 12000);
}

function ignoringArgs(readyFile: string): string[] {
	return [
		"-e",
		'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],String(process.pid));console.log(process.pid);setTimeout(()=>{},8000)',
		readyFile,
	];
}

async function waitUntilReady(path: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		try {
			expect(Number(readFileSync(path, "utf8"))).toBeGreaterThan(0);
			return;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		}
		await delay(10);
	}
	throw new Error("Child did not install its signal handler before the readiness deadline");
}

function expectPidDead(result: ExecResult): void {
	const pid = Number.parseInt(result.stdout.trim(), 10);
	expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
	try {
		process.kill(pid, 0);
	} catch (error) {
		expect(error).toMatchObject({ code: "ESRCH" });
		return;
	}
	throw new Error(`Child pid ${pid} survived execCommand escalation`);
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-exec-cancellation-"));
	pending = [];
});

afterEach(async () => {
	try {
		// Fixtures self-exit before this bound, including when the regression returns.
		await withTimeout(Promise.all(pending), 10000);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

for (const nativeOwner of [false, true]) {
	describe.skipIf(nativeOwner && !process.env.PI_PROCESS_OWNER_TEST_BINARY)(
		`execCommand (${nativeOwner ? "native owner" : "standalone"})`,
		() => {
			beforeEach(() => {
				vi.stubEnv("PI_PROCESS_OWNER_BINARY", nativeOwner ? process.env.PI_PROCESS_OWNER_TEST_BINARY : undefined);
			});
			afterEach(() => vi.unstubAllEnvs());
			it("returns stdout and exit code 0 on normal completion", async () => {
				const result = await execute(["-e", 'console.log("hi")']);
				expect(result).toMatchObject({ stdout: "hi\n", code: 0, killed: false });
			});

			it("preserves a normal nonzero exit code", async () => {
				const result = await execute(["-e", "process.exit(3)"]);
				expect(result).toMatchObject({ code: 3, killed: false });
			});

			it("force-kills a SIGTERM-ignoring child on timeout (#7864)", async () => {
				const readyFile = join(directory, "timeout-ready");
				const pendingResult = execute(ignoringArgs(readyFile), { timeout: 1000 });
				await waitUntilReady(readyFile);
				const result = await pendingResult;
				expect(result.killed).toBe(true);
				expect(result.code).not.toBe(0);
				if (process.platform !== "win32") expect(result.code).toBe(137);
				expectPidDead(result);
			});

			it("force-kills a SIGTERM-ignoring child on abort (#7864)", async () => {
				const controller = new AbortController();
				const readyFile = join(directory, "abort-ready");
				const pendingResult = execute(ignoringArgs(readyFile), { signal: controller.signal });
				await waitUntilReady(readyFile);
				controller.abort();
				const result = await pendingResult;
				expect(result.killed).toBe(true);
				expect(result.code).not.toBe(0);
				if (process.platform !== "win32") expect(result.code).toBe(137);
				expectPidDead(result);
			});

			it("does not report success when the child dies by signal (#7864)", async () => {
				const result = await execute(["-e", "process.kill(process.pid, 'SIGKILL')"]);
				expect(result.code).not.toBe(0);
			});
		},
	);
}
