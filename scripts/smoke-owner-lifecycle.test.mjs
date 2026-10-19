import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { bunTarget } from "./lib/bun-targets.mjs";
import { passedWindowsOwnerGate } from "./fixtures/windows-owner-gate.mjs";
import { windowsOwnerGateDependencies } from "./smoke-windows-owner-gate.mjs";
import { artifactBunFromOwnerRows, assertOwnerLifecycle, ownerPrivilegeDropRequired, smokeOwnerLifecycleAsNonadmin } from "./smoke-owner-lifecycle.mjs";

const standard = { name: "host\\pi-owner-smoke", uid: 1001, euid: 1001, elevated: false, adminGroup: false, mediumIntegrity: true };
const root = { uid: 0, euid: 0, elevated: true };
const rows = ["normal-double-fork", "kill-double-fork", "normal-setsid", "kill-setsid"].map((name) => ({ name, pi: { bun: "1.3.14" }, status: "passed", aliveBefore: true, aliveAfter: false, peerAlive: true, immediateChecks: 1 }));

// Host commands are mocked; copied scripts, runtime and artifact use real temporary files.
async function dropped(platform, { childIdentity = standard, childError, failCommand, existing = false, cleanupFailure = false, silentChild = false } = {}) {
	const temp = mkdtempSync(join(tmpdir(), "pi-owner-drop-test-"));
	mkdirSync(join(temp, "Temp"));
	const calls = [];
	const target = bunTarget(platform === "freebsd" ? "freebsd-x64" : platform === "darwin" ? "darwin-arm64" : platform === "win32" ? "windows-x64-baseline" : "linux-x64-musl-baseline");
	const childRows = structuredClone(rows);
	if (platform === "darwin") childRows.push({ ...childRows[0], name: "darwin-fast-escape", status: "known-limitation", limitation: "25ms sweep" });
	if (childError) { childRows[0].aliveAfter = true; childRows[0].status = "failed"; }
	const child = { status: childError ? "failed" : "passed", identity: childIdentity, rows: childRows, ...artifactBunFromOwnerRows(childRows), ...(childError ? { error: childError } : {}) };
	if (platform === "win32") child.windowsRuntimeGate = passedWindowsOwnerGate(target.id, createHash("sha256").update(readFileSync(process.execPath)).digest("hex"), standard);
	try {
		const evidence = await smokeOwnerLifecycleAsNonadmin(process.execPath, target, {
			platform, env: { CI: "true", SystemRoot: temp, SystemDrive: temp, COMPUTERNAME: "host" },
			identityProbe: () => platform === "darwin" ? { ...standard, adminGroup: true } : root,
			run: (file, args, options) => {
				calls.push({ file, args, options });
				if (file === process.execPath && args.includes("install")) {
					const work = args[args.indexOf("--prefix") + 1];
					const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
					const dependencies = windowsOwnerGateDependencies(lock);
					writeFileSync(join(work, "package-lock.json"), JSON.stringify({ packages: Object.fromEntries(dependencies.map(({ name }) => [`node_modules/${name}`, lock.packages[`node_modules/${name}`]])) }));
					return { status: 0, stdout: "", stderr: "" };
				}
				if (file === process.execPath && args.includes("ls")) {
					const dependencies = windowsOwnerGateDependencies(JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")));
					return { status: 0, stdout: JSON.stringify({ dependencies: Object.fromEntries(dependencies.map((entry) => [entry.name, entry])) }), stderr: "" };
				}
				if (file === "bun") return { status: 0, stdout: args[0] === "--version" ? "1.3.14\n" : `${process.execPath}\n`, stderr: "" };
				if (file === "sudo" && args.includes("rm")) rmSync(args.at(-1), { recursive: true, force: true });
				if (file === "id" || (file === "net.exe" && args.length === 2)) return { status: existing ? 0 : platform === "win32" ? 2 : 1, stdout: "", stderr: "" };
				if (file === failCommand) return { status: 1, stderr: "provision denied" };
				if (cleanupFailure && (args.includes("userdel") || args.includes("-deleteUser") || args.includes("/delete"))) return { status: 1, stderr: "cleanup denied" };
				const launch = file === "su" || (file === "sudo" && args.includes("-u")) || file === "powershell.exe";
				if (launch) {
					const stage = file === "sudo" ? dirname(dirname(args.find((value) => value.endsWith("smoke-owner-lifecycle.mjs")))) : options.cwd;
					if (file === "sudo") assert.equal(options.cwd, "/");
					assert.equal(existsSync(join(stage, target.executable)), true);
					assert.equal(existsSync(join(stage, "scripts", "fixtures", "owner", "descendant.mjs")), true);
					assert.equal(existsSync(join(stage, "scripts", "lib", "bun-targets.mjs")), true);
					if (platform === "win32") {
						const launcher = readFileSync(join(stage, "launch.ps1"), "utf8");
						assert.match(launcher, /\$env:HOME=/);
						assert.match(launcher, /Remove-Item Env:NODE_OPTIONS/);
						assert.match(launcher, /PI_WINDOWS_GATE_ROOT/);
						// Scratch is outside %SystemRoot%\Temp, and every runtime layer is preflighted before the strict child run.
						assert.equal(stage.startsWith(join(temp, "Temp")), false);
						for (const probe of [/cmd\.exe' '\/d' '\/c' 'ver'/, /'--version'/, /'--experimental-strip-types' '-e' '0'/, /whoami\.exe' '\/groups'/]) assert.match(launcher, probe);
						assert.ok(launcher.indexOf("preflight") < launcher.indexOf("$ErrorActionPreference='Stop'"), "preflight must not stop the launcher");
						assert.equal(existsSync(join(stage, "packages", "coding-agent", "test", "windows-owner-runtime.mjs")), true);
						assert.equal(existsSync(join(stage, "packages", "chord", "src", "manager.ts")), true);
						assert.equal(options.timeout, 1_200_000);
					}
					if (silentChild) return { status: 0, stdout: "", stderr: "child stderr tail" };
					return { status: childError ? 1 : 0, stdout: JSON.stringify(child), stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			},
		});
		return { evidence, calls };
	} finally { rmSync(temp, { recursive: true, force: true }); }
}

for (const platform of ["darwin", "win32"]) {
	test(`${platform} silent child failure carries child tails and a step trail without passwords`, async () => {
		const { evidence, calls } = await dropped(platform, { silentChild: true });
		assert.equal(evidence.status, "failed");
		assert.equal(evidence.privilegeDrop.verifiedNonadmin, false);
		assert.match(evidence.error, /child produced no identity evidence: \{"status":0/);
		assert.match(evidence.error, /child stderr tail/);
		const { child, steps } = evidence.privilegeDrop.diagnostics;
		assert.equal(child.stdout, "");
		assert.match(child.scriptRealpath, /smoke-owner-lifecycle\.mjs$|realpath failed/);
		assert.ok(steps.length > 0);
		const password = calls.find(({ args }) => args.includes("-addUser") || args.includes("/add"))?.args.find((value) => value.startsWith("Pi!9"));
		assert.ok(password, "account creation call carries a password");
		assert.equal(JSON.stringify(evidence).includes(password), false, "password must never be recorded");
	});
}

test("missing or disagreeing Bun versions remain informational outside Windows", () => {
	for (const os of ["linux", "freebsd", "darwin"]) {
		const observations = structuredClone(rows);
		delete observations[0].pi.bun;
		observations[1].pi.bun = "1.4.2";
		if (os === "darwin") observations.push({ ...observations[0], name: "darwin-fast-escape", status: "known-limitation", limitation: "25ms sweep" });
		const evidence = { status: "passed", identity: standard, rows: observations, ...artifactBunFromOwnerRows(observations) };
		assert.equal(evidence.artifactBunVersion, null);
		assert.doesNotThrow(() => assertOwnerLifecycle(evidence, os));
	}
});

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
			for (const directory of ["packages", "node_modules", "scripts"]) {
				assert.equal(calls.some(({ file, args }) => file === "icacls.exe" && args[0].endsWith(directory) && args.includes("host\\pi-owner-smoke:(OI)(CI)RX") && args.includes("/inheritance:r") && !args.includes("/T")), true);
				assert.equal(calls.some(({ file, args }) => file === "icacls.exe" && args[0].endsWith(join(directory, "*")) && args.includes("/reset") && args.includes("/T")), true);
			}
			// Contents (node.exe) must inherit the scratch grant: never combine /inheritance:r with /T.
			assert.equal(calls.some(({ file, args }) => file === "icacls.exe" && args.includes("/inheritance:r") && args.includes("/T")), false);
			assert.equal(calls.some(({ file, args }) => file === "icacls.exe" && args.includes("host\\pi-owner-smoke:(OI)(CI)F") && !args.includes("/T")), true);
		}
		assert.equal(calls.some(({ args }) => args.includes("userdel") || args.includes("-deleteUser") || args.includes("/delete") || args.some((arg) => arg.includes('exec userdel "$1"'))), true);
		const launch = calls.find(({ file, args }) => file === "su" || file === "powershell.exe" || (file === "sudo" && args.includes("-u")));
		const stage = launch.file === "sudo" ? dirname(dirname(launch.args.find((value) => value.endsWith("smoke-owner-lifecycle.mjs")))) : launch.options.cwd;
		assert.equal(existsSync(stage), false);
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
