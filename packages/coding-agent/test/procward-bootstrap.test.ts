import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPackagedProcward } from "../src/config.ts";
import { ownershipDisabled } from "../src/utils/procward.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/procward-probe.ts", import.meta.url));
const resolver = join(root, "packages/coding-agent/src/experimental/source-resolver.ts");
const command = ["--disable-warning=ExperimentalWarning", "--import", resolver, probe];
afterEach(() => vi.unstubAllEnvs());

describe("procward bootstrap options", () => {
	it("honors explicit and inherited opt-outs, not option values or positional text", () => {
		vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", "");
		expect(ownershipDisabled(["--no-process-ownership"])).toBe(true);
		for (const option of ["--system-prompt", "--name", "--theme", "--extension"]) {
			expect(ownershipDisabled([option, "--no-process-ownership"])).toBe(false);
		}
		for (const option of ["--mode", "--use-theme", "--tui-mode"]) {
			expect(ownershipDisabled([option, "--no-process-ownership"])).toBe(true);
		}
		expect(ownershipDisabled(["--", "--no-process-ownership"])).toBe(false);
		vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", "1");
		expect(ownershipDisabled([])).toBe(true);
	});
});

describe.skipIf(process.platform !== "linux")("source helper policy", () => {
	it("reports missing helper once, while opt-out stays silent", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-procward-missing-"));
		try {
			for (const disabled of [false, true]) {
				const out = spawnSync(process.execPath, command, {
					env: { ...process.env, PATH: "", PI_PACKAGE_DIR: dir, PI_NO_PROCESS_OWNERSHIP: disabled ? "1" : "" },
					encoding: "utf8",
					timeout: 10000,
				});
				expect(out.status).toBe(0);
				expect(out.stderr).toBe(
					disabled
						? ""
						: "Process ownership disabled: install procward on PATH (https://github.com/xz-dev/procward; source/npm run)\n",
				);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("rejects an incompatible present PATH helper instead of running unowned", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-procward-incompatible-"));
		try {
			const helper = join(dir, "procward");
			writeFileSync(helper, `#!${process.execPath}\nconsole.log('not procward');\n`);
			chmodSync(helper, 0o700);
			const out = spawnSync(process.execPath, command, {
				env: { ...process.env, PATH: dir, PI_PACKAGE_DIR: dir, PI_NO_PROCESS_OWNERSHIP: "" },
				encoding: "utf8",
				timeout: 10000,
			});
			expect(out.status).not.toBe(0);
			expect(out.stderr).toContain("Incompatible procward on PATH");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("rejects a failed bootstrap handoff without recursively wrapping", () => {
		const out = spawnSync(process.execPath, command, {
			env: { ...process.env, PI_PROCWARD_BOOTSTRAP_PENDING: "1", PI_NO_PROCESS_OWNERSHIP: "" },
			encoding: "utf8",
			timeout: 10000,
		});
		expect(out.status).not.toBe(0);
		expect(out.stderr).toContain("did not complete its managed-child startup handoff");
	});
});

describe.skipIf(process.platform !== "linux")("real procward managed-child boundary", () => {
	it.each(["default", "external", "flag", "environment"])("%s launch", (mode) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-procward-"));
		try {
			const trace = join(dir, "trace");
			const env = {
				...process.env,
				PROCWARD_PROBE_TRACE: trace,
				PI_NO_PROCESS_OWNERSHIP: mode === "environment" ? "1" : "",
			};
			const args = [...command, ...(mode === "flag" ? ["--no-process-ownership"] : [])];
			const out =
				mode === "external"
					? spawnSync(getPackagedProcward() ?? "procward", ["run", "--", process.execPath, ...args], {
							env,
							encoding: "utf8",
							timeout: 10000,
						})
					: spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 10000 });
			expect(out.stderr).toBe("");
			expect(out.status).toBe(0);
			const result = JSON.parse(out.stdout.trim());
			expect(result.contract.filter((key: string) => key !== "PROCWARD_PROBE_TRACE")).toEqual([]);
			const starts = readFileSync(trace, "utf8").trim().split("\n");
			expect(starts).toHaveLength(mode === "default" ? 2 : 1);
			if (mode === "default" || mode === "external") {
				expect(result.taskOwner).toMatch(/pi-env$/);
				expect(result.endpoints).toHaveLength(1);
				expect(parseInt(result.endpoints[0].flags, 8) & 0o2000000).not.toBe(0);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects inherited environment without a valid immediate owner", () => {
		const out = spawnSync(process.execPath, command, {
			env: { ...process.env, PI_NO_PROCESS_OWNERSHIP: "", PROCWARD_PROTOCOL: "1", PROCWARD_OWNER_PID: "1" },
			encoding: "utf8",
			timeout: 10000,
		});
		expect(out.status).not.toBe(0);
		expect(out.stderr).toContain("Invalid procward managed-child environment");
	});
});
