import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * End-to-end checks against the real vendored procward binary: the same
 * `procward run -- <cmd>` shape the bootstrap uses, including environment
 * inheritance (bootstrap nonce must reach the primary) and exit-status
 * passthrough. Full `pi` startup e2e lives in the tmux smoke (task 5.2).
 */

const HELPER = new URL("../native/procward/host/procward", import.meta.url).pathname;

describe("procward run e2e", () => {
	test("primary status passes through the owner", () => {
		const result = spawnSync(HELPER, ["run", "--", process.execPath, "-e", "process.exit(42)"], {
			encoding: "utf8",
		});
		expect(result.status).toBe(42);
	});

	test("primary sees the procward contract environment", () => {
		const script = `
const env = process.env;
const out = {
	protocol: env.PROCWARD_PROTOCOL,
	ownerPid: env.PROCWARD_OWNER_PID,
	launchId: env.PROCWARD_CONTRACT_ID,
	lifecycleFd: env.PROCWARD_LIFECYCLE_FD,
	ppidIsOwner: String(process.ppid) === env.PROCWARD_OWNER_PID,
	nonce: env.PI_PROCWARD_BOOTSTRAP_NONCE,
};
process.stdout.write(JSON.stringify(out));
`;
		const result = spawnSync(HELPER, ["run", "--", process.execPath, "-e", script], {
			encoding: "utf8",
			env: { ...process.env, PI_PROCWARD_BOOTSTRAP_NONCE: "e2e-nonce" },
		});
		expect(result.status).toBe(0);
		const observed = JSON.parse(result.stdout) as Record<string, unknown>;
		expect(observed.protocol).toBe("1");
		expect(observed.ownerPid).toMatch(/^[1-9][0-9]*$/);
		expect(observed.launchId).toMatch(/^[0-9a-f]{32}$/);
		expect(observed.lifecycleFd).toMatch(/^[1-9][0-9]*$/);
		expect(observed.ppidIsOwner).toBe(true);
		// The bootstrap nonce is ordinary env for procward: it must survive so
		// the inner pi can recognize its own handoff.
		expect(observed.nonce).toBe("e2e-nonce");
	});

	// procward v0.2.1 fallback (no cgroup v2 permission) leaves a spawned
	// node child pending well past its cleanup deadline; tracked upstream in
	// xz-dev/procward. Re-enable when the fallback reaps reliably.
	test.skip("background child is cleaned when the owner exits", () => {
		// Primary spawns a detached-ish background child and exits; procward
		// must not leak it past its cleanup deadline. We observe from outside:
		// run under `timeout` to bound wall time, then check the child pid is
		// gone after the owner exits.
		const dir = mkdtempSync(join(tmpdir(), "pi-procward-bg-"));
		const pidFile = join(dir, "bg.pid");
		const script = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
`;
		const result = spawnSync(HELPER, ["run", "--", process.execPath, "-e", script], { encoding: "utf8" });
		expect(result.status).toBe(0);
		void writeFileSync; // lint: referenced for clarity
		const bgPid = Number(spawnSync("cat", [pidFile], { encoding: "utf8" }).stdout.trim());
		expect(bgPid).toBeGreaterThan(0);
		// After the owner exits, the kernel-level cleanup must have reaped the
		// background child (poll a moment for the grace period to elapse).
		let gone = false;
		for (let i = 0; i < 40; i++) {
			const probe = spawnSync("kill", ["-0", String(bgPid)], { encoding: "utf8" });
			if (probe.status !== 0) {
				gone = true;
				break;
			}
			spawnSync("sleep", ["0.25"]);
		}
		expect(gone).toBe(true);
	});
});
