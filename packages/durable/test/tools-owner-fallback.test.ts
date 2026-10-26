import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type * as FsPromises from "node:fs/promises";
import { Duplex, PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";
import type { ToolExecutionApi } from "../src/harness/types.ts";
import { createPowerShellTool } from "../src/tools/bash.ts";

const { spawnMock, accessMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), accessMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof FsPromises>()), access: accessMock }));
const previousOwner = process.env.PI_PROCESS_OWNER_BINARY;

afterEach(() => {
	spawnMock.mockReset();
	accessMock.mockReset();
	if (previousOwner === undefined) delete process.env.PI_PROCESS_OWNER_BINARY;
	else process.env.PI_PROCESS_OWNER_BINARY = previousOwner;
});

// Same controlled lease and minimal tool API patterns as protocol/tools tests. No OS containment claim.
function setup(first: { report: string; helperCode: number; ran: boolean }) {
	process.env.PI_PROCESS_OWNER_BINARY = "/test/owner";
	accessMock.mockResolvedValue(undefined);
	const effects: string[] = [];
	const output: string[] = [];
	spawnMock.mockImplementation((_owner: string, args: string[]) => {
		const program = args[4]!;
		const lease = new Duplex({
			read() {},
			write(_chunk, _encoding, done) {
				done();
			},
		});
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const child = Object.assign(new EventEmitter(), {
			stdout,
			stderr,
			stdin: null,
			stdio: [null, stdout, stderr, lease],
		});
		const frame =
			program === "/test/first"
				? first
				: {
						report: 'S{"pid":124}\nX{"code":0,"signal":null}\nC\n',
						helperCode: 0,
						ran: true,
					};
		setImmediate(() => {
			if (frame.ran) effects.push(program);
			lease.push(frame.report);
			if (frame.ran) stdout.write(`${program}\n`);
			stdout.end();
			stderr.end();
			lease.push(null);
			child.emit("close", frame.helperCode, null);
		});
		return child as unknown as ChildProcess;
	});
	const env = new NodeExecutionEnv({ cwd: "/test" });
	const api = {
		taskId: 1,
		conversationId: 1,
		callId: "call",
		env,
		output: (chunk: string | Uint8Array) =>
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)),
		retainedOutput: () => ({ text: output.join(""), truncated: false }),
		diagnostic: () => {},
		details: async () => {},
		agent: async () => ({}),
	} as unknown as ToolExecutionApi;
	return { effects, api };
}

describe("UNIT PowerShell fallback through actual NodeExecutionEnv", () => {
	for (const code of [0, 125]) {
		it(`does not retry after primary ${code} executed without cleanup C`, async () => {
			const { effects, api } = setup({
				report: `S{"pid":123}\nX{"code":${code},"signal":null}\n`,
				helperCode: code,
				ran: true,
			});
			const tool = createPowerShellTool({ programs: ["/test/first", "/test/second"] });
			await expect(tool.execute({ command: "unused" }, api, BACKGROUND_CONTEXT)).rejects.toMatchObject({
				code: "unknown",
				message: "Incomplete process owner cleanup report",
				cause: { code: "ERR_PROCESS_OWNER_CLEANUP" },
			});
			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(effects).toEqual(["/test/first"]);
		});
	}

	for (const errno of [2, 13]) {
		it(`retains alternate-program fallback for genuine E${errno},C spawn failure`, async () => {
			const { effects, api } = setup({ report: `E${errno} cannot spawn\nC\n`, helperCode: 125, ran: false });
			const tool = createPowerShellTool({ programs: ["/test/first", "/test/second"] });
			const result = await tool.execute({ command: "unused" }, api, BACKGROUND_CONTEXT);
			expect(result.structuredOutput).toMatchObject({ exitCode: 0, output: "/test/second\n" });
			expect(spawnMock).toHaveBeenCalledTimes(2);
			expect(effects).toEqual(["/test/second"]);
		});
	}

	it("does not retry valid primary125+C", async () => {
		const { effects, api } = setup({
			report: 'S{"pid":123}\nX{"code":125,"signal":null}\nC\n',
			helperCode: 125,
			ran: true,
		});
		const result = await createPowerShellTool({ programs: ["/test/first", "/test/second"] }).execute(
			{ command: "unused" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(result).toMatchObject({ isError: true, structuredOutput: { exitCode: 125 } });
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(effects).toEqual(["/test/first"]);
	});
});
