import { ChildProcess } from "node:child_process";
import type * as FsModule from "node:fs";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeOwnedProcess, ownedCommand } from "../src/utils/process-owner.ts";

const state = vi.hoisted(() => ({ access: vi.fn() }));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalBunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");
vi.mock("node:fs", async (original) => ({
	...(await original<typeof FsModule>()),
	accessSync: state.access,
}));
beforeEach(() => {
	state.access.mockReset();
	vi.stubEnv("PI_PROCESS_OWNER_BINARY", "");
});
afterEach(() => {
	Object.defineProperty(process, "platform", originalPlatform);
	if (originalBunVersion) Object.defineProperty(process.versions, "bun", originalBunVersion);
	else Reflect.deleteProperty(process.versions, "bun");
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("legacy task-owner command construction", () => {
	it("keeps SDK execution unchanged outside an owned Pi session", () => {
		delete process.env.PI_PROCESS_OWNER_BINARY;
		expect(ownedCommand("tool", ["a b"])).toEqual({ command: "tool", args: ["a b"], nativeOwner: false });
		expect(state.access).not.toHaveBeenCalled();
	});

	it("rejects explicit empty owner instead of running unowned", () => {
		expect(() => ownedCommand("tool", [])).toThrow("Process owner helper is empty");
		expect(state.access).not.toHaveBeenCalled();
	});

	it("gives an owned task a separate native lifetime", () => {
		vi.stubEnv("PI_PROCESS_OWNER_BINARY", "/owner/pi-env");
		expect(ownedCommand("tool", ["a b"])).toEqual({
			command: "/owner/pi-env",
			args: ["supervise", "--", "tool", "a b"],
			nativeOwner: true,
		});
	});

	it("does not run a task unowned when its helper disappears", () => {
		vi.stubEnv("PI_PROCESS_OWNER_BINARY", "/owner/pi-env");
		state.access.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expect(() => ownedCommand("tool", [])).toThrow("ENOENT");
	});
});

describe("POSIX held-controller cancellation", () => {
	for (const mode of ["live", "exited", "signaled", "unspawned", "resume-false", "resume-error"] as const) {
		it(`resumes only live held controller, once: ${mode}`, async () => {
			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			const events: string[] = [];
			const lease = new Duplex({
				read() {},
				write(chunk, _encoding, done) {
					events.push(chunk.toString());
					done();
				},
			});
			const child = Object.assign(new ChildProcess(), {
				stdio: [null, null, null, lease],
				pid: mode === "unspawned" ? undefined : 42,
				exitCode: mode === "exited" ? 0 : null,
				signalCode: mode === "signaled" ? ("SIGTERM" as const) : null,
			});
			const kill = vi.spyOn(child, "kill").mockImplementation(() => {
				events.push("SIGCONT");
				if (mode === "resume-error") throw new Error("resume denied");
				return mode !== "resume-false";
			});
			const numericKill = vi.spyOn(process, "kill");
			const owner = observeOwnedProcess(child);
			const failed = mode === "resume-error" || mode === "resume-false";
			const checked = failed
				? expect(owner.completion).rejects.toMatchObject({ code: "ERR_PROCESS_OWNER_CLEANUP" })
				: expect(owner.completion).resolves.toEqual({ code: mode === "exited" ? 0 : 143, errno: undefined });
			child.emit("spawn");
			owner.cancel();
			owner.cancel();
			const live = mode === "live" || failed;
			expect(kill).toHaveBeenCalledTimes(live ? 1 : 0);
			if (live) expect(kill).toHaveBeenCalledWith("SIGCONT");
			expect(events).toEqual(live ? ["SIGCONT", "K"] : ["K"]);
			expect(numericKill).not.toHaveBeenCalled();
			lease.push(
				`S{"pid":42}\nX${JSON.stringify(mode === "exited" ? { code: 0, signal: null } : { code: null, signal: 15 })}\nC\n`,
			);
			lease.push(null);
			child.emit("close", mode === "exited" ? 0 : 143, null);
			await checked;
		});
	}
});

describe("Windows legacy task-owner protocol (unit, not runtime proof)", () => {
	for (const lost of [false, true]) {
		it(`Windows cancellation retains X/C beyond 50 ms; lease loss ${lost}`, async () => {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			let writes = "";
			const lease = new Duplex({
				read() {},
				write(chunk, _encoding, done) {
					writes += chunk.toString();
					done();
				},
			});
			const child = Object.assign(new ChildProcess(), { stdio: [null, null, null, lease] });
			const owner = observeOwnedProcess(child);
			let settled = false;
			const outcome = owner.completion.then(
				(value) => {
					settled = true;
					return value;
				},
				(error: unknown) => {
					settled = true;
					return error;
				},
			);
			child.emit("spawn");
			lease.push('S{"pid":42}\n');
			owner.cancel();
			owner.cancel();
			expect(writes).toBe("K");
			expect(lease.writableEnded).toBe(false);
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(settled).toBe(false);
			expect(lease.destroyed).toBe(false);
			if (lost) lease.destroy();
			else {
				lease.push('X{"code":137,"signal":null}\nC\n');
				lease.push(null);
			}
			await new Promise((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
			child.emit("close", 137, null);
			if (lost) expect(await outcome).toMatchObject({ code: "ERR_PROCESS_OWNER_CLEANUP" });
			else expect(await outcome).toEqual({ code: 137, errno: undefined });
			expect(lease.destroyed).toBe(true);
		});
	}
	for (const valid of [true, false])
		it(`Bun u8 helper close ${valid ? "preserves full X" : "must still match X"}`, async () => {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			Object.defineProperty(process.versions, "bun", { value: "1.3.14", configurable: true });
			const lease = new Duplex({
				read() {},
				write(_chunk, _encoding, done) {
					done();
				},
			});
			const child = Object.assign(new ChildProcess(), { stdio: [null, null, null, lease] });
			const owner = observeOwnedProcess(child);
			const checked = valid
				? expect(owner.completion).resolves.toEqual({ code: 3221225477, errno: undefined })
				: expect(owner.completion).rejects.toMatchObject({ code: "ERR_PROCESS_OWNER_CLEANUP" });
			child.emit("spawn");
			lease.push('S{"pid":42}\nX{"code":3221225477,"signal":null}\nC\n');
			lease.push(null);
			child.emit("close", valid ? 5 : 6, null);
			await checked;
		});

	it("preserves Windows/Bun CreateProcess errors even when no control handle exists", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const child = Object.assign(new ChildProcess(), { stdio: [null, null, null, null] });
		const owner = observeOwnedProcess(child);
		const error = new Error("CreateProcess failed");
		const rejected = expect(owner.completion).rejects.toBe(error);
		child.emit("error", error);
		child.emit("close", 125, null);
		await rejected;
	});
});
