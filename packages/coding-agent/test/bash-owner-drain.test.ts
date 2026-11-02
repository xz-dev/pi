import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("child_process", async (original) => ({ ...(await original<typeof childProcess>()), spawn }));

import { createLocalShellOperations } from "../src/core/tools/bash.ts";

// Deterministic ordering test, not process-containment or platform evidence.
describe.skipIf(!process.env.PI_PROCESS_OWNER_TEST_BINARY)("native shell control drain", () => {
	it("waits for private E bytes after process exit and ordinary stdio end", async () => {
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const control = new PassThrough();
		const child = Object.assign(new childProcess.ChildProcess(), {
			pid: 2147483647,
			stdin: null,
			stdout,
			stderr,
			stdio: [null, stdout, stderr, control],
		});
		let spawned: () => void = () => {};
		const atSpawn = new Promise<void>((resolve) => {
			spawned = resolve;
		});
		spawn.mockImplementationOnce(() => {
			spawned();
			return child;
		});
		const previous = process.env.PI_PROCESS_OWNER_BINARY;
		process.env.PI_PROCESS_OWNER_BINARY = process.env.PI_PROCESS_OWNER_TEST_BINARY;
		let settled = false;
		try {
			const operations = createLocalShellOperations("sh", () => ({ shell: "/missing-shell-drain", args: ["-c"] }));
			const pending = operations.exec("unused", process.cwd(), { onData: () => {} }).then(
				(value) => {
					settled = true;
					return { value, error: undefined };
				},
				(error: unknown) => {
					settled = true;
					return { value: undefined, error };
				},
			);
			await atSpawn;
			stdout.end();
			stderr.end();
			Object.defineProperty(child, "exitCode", { value: 125 });
			child.emit("exit", 125, null);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(settled, false, "exit/stdio completion must not retire the private control stream");
			control.end("E2 No such file or directory\nC\n");
			child.emit("close", 125, null);
			const outcome = await pending;
			assert.equal(outcome.value, undefined);
			assert.ok(outcome.error instanceof Error);
			assert.equal((outcome.error as NodeJS.ErrnoException).code, "ENOENT");
		} finally {
			stdout.destroy();
			stderr.destroy();
			control.destroy();
			spawn.mockReset();
			if (previous === undefined) delete process.env.PI_PROCESS_OWNER_BINARY;
			else process.env.PI_PROCESS_OWNER_BINARY = previous;
		}
	});
});
