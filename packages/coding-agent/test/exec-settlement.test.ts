import type * as ChildProcessModule from "node:child_process";
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import type * as ChildProcessUtilities from "../src/utils/child-process.ts";
import { waitForChildProcess } from "../src/utils/child-process.ts";
import type * as ProcessOwner from "../src/utils/process-owner.ts";

const spawn = vi.hoisted(() => vi.fn());
const invocation = vi.hoisted(() =>
	vi.fn((command: string, args: string[]) => ({ command, args, nativeOwner: false })),
);
vi.mock("../src/utils/process-owner.ts", async (original) => ({
	...(await original<typeof ProcessOwner>()),
	ownedCommand: invocation,
}));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcessModule>()),
	spawn,
}));
vi.mock("../src/utils/child-process.ts", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcessUtilities>()),
	waitForChildProcess: vi.fn(),
}));

let child: ChildProcess;
let resolveWait: (code: number | null) => void;
let rejectWait: (error: Error) => void;

beforeEach(() => {
	vi.useFakeTimers();
	invocation.mockImplementation((command, args) => ({ command, args, nativeOwner: false }));
	child = new ChildProcess();
	spawn.mockReturnValue(child);
	vi.spyOn(child, "kill").mockReturnValue(false);
	vi.mocked(waitForChildProcess).mockReturnValue(
		new Promise<number | null>((resolve, reject) => {
			resolveWait = resolve;
			rejectWait = reject;
		}),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("execCommand settlement (#7864)", () => {
	it("waits for native cleanup without killing the outer owner", async () => {
		invocation.mockImplementation((command, args) => ({ command, args, nativeOwner: true }));
		const control = new PassThrough();
		Object.assign(child, { stdio: [null, null, null, control] });
		const controller = new AbortController();
		let settled = false;
		const result = execCommand("program", [], process.cwd(), { signal: controller.signal });
		void result.then(() => {
			settled = true;
		});
		controller.abort();
		await vi.advanceTimersByTimeAsync(6000);
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(settled).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		child.emit("exit", 137, null);
		control.end('S{"pid":42}\nX{"code":null,"signal":9}\nC\n');
		child.emit("close", 137, null);
		expect(await result).toMatchObject({ code: 137, killed: true });
	});

	it("does not keep a force-kill timer after pre-aborted spawn failure", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = execCommand("missing-executable", [], process.cwd(), { signal: controller.signal });
		rejectWait(new Error("spawn ENOENT"));
		expect(await result).toMatchObject({ code: 1, killed: true });
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(5000);
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("does not cancel an exited child while inherited output is draining", async () => {
		const controller = new AbortController();
		const result = execCommand("program", [], process.cwd(), { signal: controller.signal });
		child.emit("exit", 0, null);
		controller.abort();
		resolveWait(0);
		expect(await result).toMatchObject({ code: 0, killed: false });
		expect(child.kill).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
