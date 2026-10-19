import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownCliProcesses, ownedCommand } from "../src/utils/process-owner.ts";

const state = vi.hoisted(() => ({
	bundled: false,
	access: vi.fn(),
	materialize: false,
	resource: vi.fn<(options: { sourceDir: string; relativePath: string; fileMode: number }) => unknown>(),
}));
const originalArgv = process.argv;
vi.mock("node:fs", () => ({ accessSync: state.access, constants: { X_OK: 1 } }));
vi.mock("../src/config.ts", () => ({
	getPackageDir: () => "/private/pi",
	get isBunBinary() {
		return state.bundled;
	},
	get materializeResourceTree() {
		return state.materialize ? state.resource : undefined;
	},
}));
const handoff = new Error("handoff stopped by test");
const execute = vi.fn<NonNullable<typeof process.execve>>(() => {
	throw handoff;
});

beforeEach(() => {
	state.bundled = false;
	state.materialize = false;
	state.resource.mockReset();
	state.access.mockReset();
	execute.mockClear();
	vi.stubEnv("PI_PROCESS_OWNER_PID", "");
	vi.stubEnv("PI_PROCESS_OWNER_PENDING", "");
	vi.stubEnv("PI_PROCESS_OWNER_BINARY", "");
	vi.spyOn(process, "execve").mockImplementation(execute);
});

afterEach(() => {
	process.argv = originalArgv;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe.skipIf(process.platform !== "linux" && process.platform !== "freebsd" && process.platform !== "darwin")(
	"CLI process ownership",
	() => {
		it("enters the packaged owner with original runtime arguments and environment", () => {
			vi.stubEnv("PI_OWNER_TEST_VALUE", "preserved");
			expect(ownCliProcesses).toThrow(handoff);
			const [binary, args, env] = execute.mock.calls[0];
			expect(binary).toBe("/private/pi/dist/native/process-owner/pi-env");
			expect(args).toEqual([
				binary,
				"supervise",
				"--",
				process.execPath,
				...process.execArgv,
				...process.argv.slice(1),
			]);
			expect(env?.PI_OWNER_TEST_VALUE).toBe("preserved");
			expect(env?.PI_PROCESS_OWNER_PENDING).toBe("1");
			expect(env?.PI_PROCESS_OWNER_PID).toBeUndefined();
			expect(Object.values(env ?? {}).every((value) => typeof value === "string")).toBe(true);
		});

		it("consumes the guardian's one-shot handoff before extensions inherit it", () => {
			vi.stubEnv("PI_PROCESS_OWNER_PID", String(process.ppid));
			ownCliProcesses();
			expect(execute).not.toHaveBeenCalled();
			expect(state.access).toHaveBeenCalledOnce();
			expect(process.env.PI_PROCESS_OWNER_BINARY).toBe("/private/pi/dist/native/process-owner/pi-env");
			expect(process.env.PI_PROCESS_OWNER_PID).toBeUndefined();
			expect(process.env.PI_PROCESS_OWNER_PENDING).toBeUndefined();
		});

		it("does not recursively restart with an incompatible owner binary", () => {
			vi.stubEnv("PI_PROCESS_OWNER_PENDING", "1");
			expect(ownCliProcesses).toThrow("Process owner did not complete its startup handoff");
			expect(execute).not.toHaveBeenCalled();
		});

		it("does not accept a marker belonging to another parent", () => {
			vi.stubEnv("PI_PROCESS_OWNER_PID", String(process.ppid + 1));
			expect(ownCliProcesses).toThrow(handoff);
			expect(execute.mock.calls[0][2]?.PI_PROCESS_OWNER_PID).toBeUndefined();
		});

		it("does not pass Bun's virtual entrypoint back as a user argument", () => {
			state.bundled = true;
			expect(ownCliProcesses).toThrow(handoff);
			const [binary, args] = execute.mock.calls[0];
			expect(binary).toBe("/private/pi/native/process-owner/pi-env");
			expect(args).toEqual([binary, "supervise", "--", process.execPath, ...process.argv.slice(2)]);
		});

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

		it("keeps version-only startup free of helper materialization", () => {
			process.argv = [process.execPath, "/cli.ts", "--version"];
			ownCliProcesses();
			expect(execute).not.toHaveBeenCalled();
			expect(state.access).not.toHaveBeenCalled();
			expect(state.resource).not.toHaveBeenCalled();
		});

		it("still owns help startup because help loads extensions", () => {
			process.argv = [process.execPath, "/cli.ts", "--help"];
			expect(ownCliProcesses).toThrow(handoff);
		});

		it("materializes embedded executables through the existing resource interface", () => {
			state.bundled = true;
			state.materialize = true;
			state.resource.mockReturnValue("/cache/process-owner");
			expect(ownCliProcesses).toThrow(handoff);
			expect(state.resource).toHaveBeenCalledWith({
				sourceDir: "/private/pi/process-owner",
				relativePath: "process-owner",
				fileMode: 0o700,
			});
			expect(execute.mock.calls[0][0]).toBe("/cache/process-owner/pi-env");
		});

		it("rejects invalid materialization instead of running unowned", () => {
			state.bundled = true;
			state.materialize = true;
			state.resource.mockReturnValue(undefined);
			expect(ownCliProcesses).toThrow("Process owner materialization failed");
			expect(execute).not.toHaveBeenCalled();
		});

		it("does not run unowned when the shipped helper is missing", () => {
			state.access.mockImplementation(() => {
				throw new Error("ENOENT");
			});
			expect(ownCliProcesses).toThrow("Process owner helper is unavailable");
			expect(execute).not.toHaveBeenCalled();
		});
	},
);
