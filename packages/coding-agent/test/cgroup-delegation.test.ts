import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cgroupDelegationDiagnostics } from "../src/utils/cgroup-delegation.ts";

const fs = vi.hoisted(() => ({ read: vi.fn(), exists: vi.fn(), access: vi.fn(), realpath: vi.fn() }));
vi.mock("node:fs", () => ({
	readFileSync: fs.read,
	existsSync: fs.exists,
	accessSync: fs.access,
	realpathSync: fs.realpath,
	constants: { W_OK: 2, X_OK: 1 },
}));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const options = { offlineMode: false, quietStartup: false };

beforeEach(() => {
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
	vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");
	vi.stubEnv("PI_ENV_CGROUP_PARENT", "");
	fs.read
		.mockReset()
		.mockImplementation((path: string) =>
			path === "/proc/self/mountinfo"
				? "29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n"
				: "0::/user.slice/pi.scope\n",
		);
	fs.exists.mockReset().mockReturnValue(true);
	fs.access.mockReset();
	fs.realpath.mockReset().mockImplementation((path: string) => path);
});
afterEach(() => {
	Object.defineProperty(process, "platform", platform);
	vi.unstubAllEnvs();
});

describe("cgroup delegation startup diagnostic", () => {
	it.each([
		{ offlineMode: true, quietStartup: false },
		{ offlineMode: false, quietStartup: true },
	])("skips filesystem detection for %j", (flags) => {
		expect(cgroupDelegationDiagnostics(flags)).toEqual([]);
		expect(fs.read).not.toHaveBeenCalled();
	});

	it("does nothing outside Linux", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		expect(cgroupDelegationDiagnostics(options)).toEqual([]);
		expect(fs.read).not.toHaveBeenCalled();
	});

	it("does not warn with writable configured delegation", () => {
		vi.stubEnv("PI_ENV_CGROUP_PARENT", "/sys/fs/cgroup/user.slice/pi.scope");
		expect(cgroupDelegationDiagnostics(options)).toEqual([]);
		expect(fs.access).toHaveBeenCalledWith("/sys/fs/cgroup/user.slice/pi.scope/cgroup.procs", 2);
	});

	it("emits exactly one actionable startup warning when delegation could help", () => {
		const diagnostics = cgroupDelegationDiagnostics(options);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].type).toBe("warning");
		expect(diagnostics[0].message).toContain("PI_ENV_CGROUP_PARENT");
		expect(diagnostics[0].message).toContain("systemd-run --user --scope -p Delegate=yes pi");
		expect(diagnostics[0].message).toContain("External cgroup runner remains disabled");
	});

	it("warns when configured delegation is not writable", () => {
		vi.stubEnv("PI_ENV_CGROUP_PARENT", "/sys/fs/cgroup/user.slice/pi.scope");
		fs.access.mockImplementation(() => {
			throw new Error("EACCES");
		});
		expect(cgroupDelegationDiagnostics(options)).toHaveLength(1);
	});

	it.each(["cgroup.kill", "cgroup.subtree_control", "systemd/private+bus"])(
		"does not warn without prerequisite %s",
		(missing) => {
			fs.exists.mockImplementation((path: string) =>
				missing === "systemd/private+bus" ? !path.startsWith("/run/user/") : !path.endsWith(missing),
			);
			expect(cgroupDelegationDiagnostics(options)).toEqual([]);
		},
	);

	it("checks cgroup.kill below the mount, not at the hierarchy root", () => {
		fs.exists.mockImplementation((path: string) => path !== "/sys/fs/cgroup/cgroup.kill");
		expect(cgroupDelegationDiagnostics(options)).toHaveLength(1);
	});

	it("accepts kernel support proven by a configured non-root parent", () => {
		vi.stubEnv("PI_ENV_CGROUP_PARENT", "/sys/fs/cgroup/delegated");
		fs.exists.mockImplementation((path: string) =>
			path.endsWith("cgroup.kill") ? path === "/sys/fs/cgroup/delegated/cgroup.kill" : true,
		);
		fs.access.mockImplementation(() => {
			throw new Error("EACCES");
		});
		expect(cgroupDelegationDiagnostics(options)).toHaveLength(1);
	});

	it("does not warn if topology cannot be read", () => {
		fs.read.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expect(cgroupDelegationDiagnostics(options)).toEqual([]);
	});
});
