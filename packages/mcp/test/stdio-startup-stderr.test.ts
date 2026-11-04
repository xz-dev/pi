import { EventEmitter } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("cross-spawn", () => ({ default: spawn }));

import { StdioTransport } from "../src/transports/stdio.ts";

const previous = process.env.PI_PROCESS_OWNER_BINARY;
const tick = () => new Promise((resolve) => setImmediate(resolve));
afterEach(() => {
	spawn.mockReset();
	if (previous === undefined) delete process.env.PI_PROCESS_OWNER_BINARY;
	else process.env.PI_PROCESS_OWNER_BINARY = previous;
});

// UNIT ordering/stream tests only: synthetic processes never establish containment evidence.
describe("native startup stderr routing", () => {
	for (const mode of ["pipe", "inherit", "failure", "eof"] as const) {
		it(`preserves ${mode} startup bytes and disposition`, async () => {
			process.env.PI_PROCESS_OWNER_BINARY = "/synthetic-owner";
			const stdin = new PassThrough();
			const stdout = new PassThrough();
			const stderr = mode === "inherit" ? null : new PassThrough();
			const control = new Duplex({
				read() {},
				write(_chunk, _encoding, callback) {
					callback();
				},
			});
			const child = Object.assign(new EventEmitter(), {
				pid: 2147483647,
				exitCode: null,
				signalCode: null,
				kill: vi.fn(() => true),
				stdin,
				stdout,
				stderr,
				stdio: [stdin, stdout, stderr, control],
			});
			spawn.mockReturnValueOnce(child);
			const captured: string[] = [];
			const transport = new StdioTransport({
				command: "/synthetic-server",
				stderr: mode === "inherit" ? "inherit" : "pipe",
				maxStderrBytes: 4,
				onStderr: (chunk) => captured.push(chunk),
			});
			const startup = transport.start().then(
				() => undefined,
				(error: unknown) => error,
			);
			try {
				expect(spawn.mock.calls[0][2].stdio[2]).toBe(mode === "inherit" ? "inherit" : "pipe");
				stderr?.write("PREFIX--TAIL");
				// Model the automatic stdio flush a ChildProcess can request on exit.
				stderr?.resume();
				await tick();
				expect(captured).toEqual([]);
				if (mode === "eof") control.push(null);
				else control.push(mode === "failure" ? "E2 No such file or directory\n" : 'S{"pid":123}\n');
				if (mode === "pipe" || mode === "inherit") {
					expect(await startup).toBeUndefined();
					await tick();
					expect(captured.join("")).toBe(mode === "pipe" ? "PREFIX--TAIL" : "");
					expect(transport.stderr).toBe(mode === "pipe" ? "TAIL" : "");
				}
			} finally {
				if (mode !== "eof") {
					control.push(mode === "failure" ? "C\n" : 'X{"code":0,"signal":null}\nC\n');
				}
				const code = mode === "failure" ? 125 : 0;
				Object.defineProperty(child, "exitCode", { value: code });
				child.emit("exit", code, null);
				stdin.end();
				stdout.end();
				stderr?.end();
				control.push(null);
				child.emit("close", code, null);
				if (mode === "eof")
					await expect(transport.close()).rejects.toMatchObject({ code: "ERR_PROCESS_OWNER_CLEANUP" });
				else await transport.close();
			}
			const failure = await startup;
			if (mode === "failure" || mode === "eof") {
				if (mode === "failure") expect(failure).toMatchObject({ code: "ENOENT", path: "/synthetic-server" });
				else expect(failure).toMatchObject({ code: "ERR_PROCESS_OWNER_CLEANUP" });
				expect(captured).toEqual([]);
				expect(transport.stderr).toBe("");
			}
		}, 3000);
	}
});
