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
	it.each(["forged", "a".repeat(32)])(
		"fails closed for stale private marker %s with one actionable CLI error",
		(nonce) => {
			const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
			const out = spawnSync(process.execPath, [...command.slice(0, -1), cli, "--version"], {
				env: { ...process.env, PI_PROCWARD_BOOTSTRAP_NONCE: nonce, PI_NO_PROCESS_OWNERSHIP: "" },
				encoding: "utf8",
				timeout: 10000,
			});
			expect(out.status).not.toBe(0);
			expect(out.stdout).toBe("");
			expect(out.stderr.trim().split("\n")).toHaveLength(1);
			expect(out.stderr).toContain("PI_PROCWARD_BOOTSTRAP_NONCE");
			expect(out.stderr).toContain("unset PI_PROCWARD_BOOTSTRAP_NONCE");
			expect(out.stderr).toContain("--no-process-ownership / PI_NO_PROCESS_OWNERSHIP=1");
		},
	);
	it.each(["wrong-primary", "wrong-owner", "wrong-launch", "wrong-version", "eof-before"])(
		"fails closed for marker with invalid READY (%s)",
		(mode) => {
			const fixture = fileURLToPath(new URL("./fixtures/procward-consumer.py", import.meta.url));
			const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
			const out = spawnSync("python3", [fixture, process.execPath, resolver, cli, `bootstrap-${mode}`], {
				encoding: "utf8",
				timeout: 10000,
			});
			expect(out.status).toBe(0);
			const result = JSON.parse(out.stdout);
			expect(result.code).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr.trim().split("\n")).toHaveLength(1);
			expect(result.stderr).toContain("unset PI_PROCWARD_BOOTSTRAP_NONCE");
		},
	);
	it.each(["flag", "environment"])("%s opt-out wins over stale marker and invalid contract", (mode) => {
		const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const out = spawnSync(
			process.execPath,
			[...command.slice(0, -1), cli, "--version", ...(mode === "flag" ? ["--no-process-ownership"] : [])],
			{
				env: {
					...process.env,
					PI_PROCWARD_BOOTSTRAP_NONCE: "stale",
					PROCWARD_PROTOCOL: "invalid",
					PROCWARD_LIFECYCLE_FD: "9999999",
					PI_NO_PROCESS_OWNERSHIP: mode === "environment" ? "1" : "",
				},
				encoding: "utf8",
				timeout: 10000,
			},
		);
		expect(out.status).toBe(0);
		expect(out.stderr).toBe("");
		expect(out.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});
});

describe.skipIf(process.platform !== "linux")("real procward managed-child boundary", () => {
	it.each([
		"default",
		"external",
		"nested",
		"flag",
		"environment",
		"external-flag",
		"external-environment",
		"nested-flag",
		"nested-environment",
	])("%s launch", (mode) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-procward-"));
		try {
			const trace = join(dir, "trace");
			const env = {
				...process.env,
				PROCWARD_PROBE_TRACE: trace,
				PI_NO_PROCESS_OWNERSHIP: mode === "environment" || mode === "external-environment" ? "1" : "",
				PI_PROCWARD_PROBE_NEST: mode.startsWith("nested") ? "1" : "",
				PI_PROCWARD_PROBE_CHILD_OPT_OUT: mode.slice("nested-".length),
			};
			const helper = getPackagedProcward() ?? "procward";
			const baseline = spawnSync(helper, ["run", "--", process.execPath, ...command, "--no-process-ownership"], {
				env: { ...process.env, PI_NO_PROCESS_OWNERSHIP: "" },
				encoding: "utf8",
				timeout: 10000,
			});
			expect(baseline.status).toBe(0);
			const oneLayer = JSON.parse(baseline.stdout.trim()).layers;
			expect(oneLayer).toBeGreaterThan(0);
			const args = [...command, ...(mode === "flag" || mode === "external-flag" ? ["--no-process-ownership"] : [])];
			const out = mode.startsWith("external")
				? spawnSync(helper, ["run", "--", process.execPath, ...args], {
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
			expect(result.bootstrapNonce).toBeUndefined();
			const disabled = mode.includes("flag") || mode.includes("environment");
			const nested = mode.startsWith("nested");
			expect(starts).toHaveLength(nested ? (disabled ? 3 : 4) : disabled ? 1 : 2);
			expect(result.layers).toBe(
				oneLayer * (disabled ? (mode.startsWith("external") || nested ? 1 : 0) : mode === "default" ? 1 : 2),
			);
			if (!disabled) {
				expect(result.taskOwner).toMatch(/pi-env$/);
				expect(result.endpoints).toHaveLength(1);
				expect(parseInt(result.endpoints[0].flags, 8) & 0o2000000).not.toBe(0);
			} else {
				expect(result.taskOwner).toBeUndefined();
				expect(result.endpoints).toHaveLength(0);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("discards inherited external metadata without adopting its READY", () => {
		const out = spawnSync(process.execPath, command, {
			env: {
				...process.env,
				PI_NO_PROCESS_OWNERSHIP: "",
				PROCWARD_PROTOCOL: "1",
				PROCWARD_OWNER_PID: "1",
				PI_PROCWARD_BOOTSTRAP_PENDING: "1",
			},
			encoding: "utf8",
			timeout: 10000,
		});
		expect(out.status).toBe(0);
		expect(out.stderr).toBe("");
		expect(JSON.parse(out.stdout.trim()).taskOwner).toMatch(/pi-env$/);
	});
});
