import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bunTarget } from "./lib/bun-targets.mjs";
import { assertOwnerLifecycle, ownerPrivilegeDropRequired, smokeOwnerLifecycleAsNonadmin } from "./smoke-owner-lifecycle.mjs";

const standard = { uid: 1001, euid: 1001, elevated: false, adminGroup: false, mediumIntegrity: true };
const root = { uid: 0, euid: 0, elevated: true };
const rows = ["normal-double-fork", "kill-double-fork", "normal-setsid", "kill-setsid"].map((name) => ({ name, status: "passed", aliveBefore: true, aliveAfter: false, peerAlive: true, immediateChecks: 1 }));

// Host commands are mocked; copied scripts, runtime and artifact use real temporary files.
async function dropped(platform, { childIdentity = standard, childError, failCommand, existing = false, cleanupFailure = false } = {}) {
	const temp = mkdtempSync(join(tmpdir(), "pi-owner-drop-test-"));
	mkdirSync(join(temp, "Temp"));
	const calls = [];
	const target = bunTarget(platform === "freebsd" ? "freebsd-x64" : platform === "darwin" ? "darwin-arm64" : platform === "win32" ? "windows-x64-baseline" : "linux-x64-musl-baseline");
	const childRows = structuredClone(rows);
	if (platform === "darwin") childRows.push({ ...childRows[0], name: "darwin-fast-escape", status: "known-limitation", limitation: "25ms sweep" });
	if (childError) { childRows[0].aliveAfter = true; childRows[0].status = "failed"; }
	const child = { status: childError ? "failed" : "passed", identity: childIdentity, rows: childRows, ...(childError ? { error: childError } : {}) };
	try {
		const evidence = await smokeOwnerLifecycleAsNonadmin(process.execPath, target, {
			platform, env: { CI: "true", SystemRoot: temp, COMPUTERNAME: "host" },
			identityProbe: () => platform === "darwin" ? { ...standard, adminGroup: true } : root,
			run: (file, args, options) => {
				calls.push({ file, args, options });
				if (file === "sudo" && args.includes("rm")) rmSync(args.at(-1), { recursive: true, force: true });
				if (file === "id" || (file === "net.exe" && args.length === 2)) return { status: existing ? 0 : platform === "win32" ? 2 : 1, stdout: "", stderr: "" };
				if (file === failCommand) return { status: 1, stderr: "provision denied" };
				if (cleanupFailure && (args.includes("userdel") || args.includes("-deleteUser") || args.includes("/delete"))) return { status: 1, stderr: "cleanup denied" };
				const launch = file === "su" || (file === "sudo" && args.includes("-u")) || file === "powershell.exe";
				if (launch) {
					const stage = options.cwd;
					assert.equal(existsSync(join(stage, target.executable)), true);
					assert.equal(existsSync(join(stage, "scripts", "fixtures", "owner", "descendant.mjs")), true);
					assert.equal(existsSync(join(stage, "scripts", "lib", "bun-targets.mjs")), true);
					if (platform === "win32") {
						const launcher = readFileSync(join(stage, "launch.ps1"), "utf8");
						assert.match(launcher, /\$env:HOME=/);
						assert.match(launcher, /Remove-Item Env:NODE_OPTIONS/);
					}
					return { status: childError ? 1 : 0, stdout: JSON.stringify(child), stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			},
		});
		return { evidence, calls };
	} finally { rmSync(temp, { recursive: true, force: true }); }
}

test("drop decisions require explicit CI and a privileged supported host identity", () => {
	for (const platform of ["linux", "freebsd", "darwin", "win32"]) {
		for (const identity of [root, { ...standard, euid: 0 }, { ...standard, elevated: true }, { ...standard, adminGroup: true }]) {
			assert.equal(ownerPrivilegeDropRequired(platform, identity, {}), false);
			assert.equal(ownerPrivilegeDropRequired(platform, identity, { CI: "false", GITHUB_ACTIONS: "false" }), false);
			assert.equal(ownerPrivilegeDropRequired(platform, identity, { CI: "1" }), false);
			assert.equal(ownerPrivilegeDropRequired(platform, identity, { CI: "true" }), true);
			assert.equal(ownerPrivilegeDropRequired(platform, identity, { GITHUB_ACTIONS: "true" }), true);
			assert.equal(ownerPrivilegeDropRequired(platform, identity, { PI_XZ_EXECUTOR: "pinned-musl-container" }), true);
			assert.equal(ownerPrivilegeDropRequired(platform, identity, { PI_XZ_EXECUTOR: "freebsd-vm" }), true);
			assert.equal(ownerPrivilegeDropRequired(platform, identity, { PI_XZ_EXECUTOR: "local" }), false);
		}
		assert.equal(ownerPrivilegeDropRequired(platform, standard, { CI: "true" }), false);
	}
	assert.equal(ownerPrivilegeDropRequired("aix", root, { CI: "true" }), false);
});

for (const platform of ["linux", "freebsd", "darwin", "win32"]) {
	test(`${platform} provisions a dedicated account and accepts only child identity evidence`, async () => {
		const { evidence, calls } = await dropped(platform);
		assert.equal(evidence.status, "passed", JSON.stringify(evidence));
		assert.deepEqual(evidence.identity, standard);
		assert.equal(evidence.privilegeDrop.user, "pi-owner-smoke");
		assert.equal(evidence.privilegeDrop.verifiedNonadmin, true);
		assert.ok(evidence.privilegeDrop.path);
		assert.equal(calls.some(({ args }) => args.includes("nobody") || args.includes("-admin")), false);
		if (platform === "freebsd") {
			assert.equal(calls.some(({ file, args }) => file === "pw" && args[0] === "useradd" && args.includes("-m") && args.includes("/bin/sh")), true);
			assert.equal(calls.some(({ file, args }) => file === "su" && args[0] === "-m" && args[1] === "pi-owner-smoke" && args.at(-1).includes("'-i'")), true);
		} else if (platform === "darwin") {
			assert.equal(calls.some(({ file, args }) => file === "sudo" && args.includes("sysadminctl") && args.includes("-addUser")), true);
			assert.equal(calls.some(({ file, args }) => file === "sudo" && args.includes("-u") && args.includes("-H") && args.includes("-i")), true);
		} else if (platform === "win32") {
			assert.equal(calls.some(({ file, args }) => file === "net.exe" && args.includes("/add")), true);
			assert.equal(calls.some(({ file, args }) => file === "powershell.exe" && args.at(-1).includes("-Credential $c") && args.at(-1).includes("-Wait -PassThru")), true);
			assert.equal(calls.some(({ file }) => file === "icacls.exe"), true);
		}
		assert.equal(calls.some(({ args }) => args.includes("userdel") || args.includes("-deleteUser") || args.includes("/delete") || args.some((arg) => arg.includes('exec userdel "$1"'))), true);
		const launch = calls.find(({ file, args }) => file === "su" || file === "powershell.exe" || (file === "sudo" && args.includes("-u")));
		assert.equal(existsSync(launch.options.cwd), false);
	});
}

test("privileged and non-medium child tokens fail identity; never report verifiedNonadmin", async () => {
	for (const [platform, childIdentity] of [["freebsd", root], ["darwin", { ...standard, adminGroup: true }], ["win32", { ...standard, mediumIntegrity: false }]]) {
		const { evidence } = await dropped(platform, { childIdentity });
		assert.equal(evidence.status, "failed");
		assert.equal(evidence.privilegeDrop.verifiedNonadmin, false);
		assert.match(evidence.error, /identity\/setup failed: owner lifecycle missing nonadmin identity/);
	}
});

test("verified Windows identity cannot hide containment failures", async () => {
	const { evidence } = await dropped("win32", { childError: "owner lifecycle containment failed: normal-double-fork" });
	assert.equal(evidence.status, "failed");
	assert.equal(evidence.privilegeDrop.verifiedNonadmin, true);
	assert.match(evidence.error, /child failed: owner lifecycle containment failed/);
	assert.throws(() => assertOwnerLifecycle(evidence, "windows"), /containment failed/);
});

test("provision failure and existing account fail closed without a privileged fallback", async () => {
	for (const options of [{ failCommand: "pw" }, { existing: true }]) {
		const { evidence, calls } = await dropped("freebsd", options);
		assert.equal(evidence.status, "failed");
		assert.equal(evidence.privilegeDrop.verifiedNonadmin, false);
		assert.match(evidence.error, /identity\/setup failed/);
		assert.equal(calls.some(({ file }) => file === "su"), false);
		if (options.existing) assert.equal(calls.length, 1);
	}
});

test("account cleanup failure is a warning, not acceptance credit or a failed smoke", async () => {
	const { evidence } = await dropped("win32", { cleanupFailure: true });
	assert.equal(evidence.status, "passed");
	assert.match(evidence.privilegeDrop.cleanupWarnings[0], /user cleanup: net.exe: cleanup denied/);
});
