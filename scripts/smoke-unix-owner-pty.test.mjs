import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { buildOwnerPty } from "./build-owner-pty.mjs";
import { bunTarget } from "./lib/bun-targets.mjs";
import { passedUnixIdentity, passedUnixOwnerPtyRow } from "./fixtures/unix-owner-pty.mjs";
import { artifactBunFromOwnerRows, assertNonadminIdentity, assertOwnerLifecycle, ownerLifecycleRows } from "./smoke-owner-lifecycle.mjs";
import { assertUnixOwnerPtyRow, isUnixOwnerPtyRow, smokeUnixOwnerPty, unixOwnerFaultRows } from "./smoke-unix-owner-pty.mjs";

const digest = "d".repeat(64);
const descriptor = bunTarget("linux-x64-gnu-baseline");
const identity = passedUnixIdentity();
const proof = (os, name = "paused-guardian-death") => passedUnixOwnerPtyRow(name, os, descriptor.id, digest);
const verify = (row, os = "linux") => assertUnixOwnerPtyRow(row, os, identity, descriptor.id, digest);

for (const os of ["linux", "freebsd", "darwin"]) {
	test(`${os} exact PTY row inventory and positive proof accepted`, () => {
		for (const name of ["suspend-resume", ...unixOwnerFaultRows(os)]) verify(proof(os, name), os);
		assert.equal(ownerLifecycleRows(os).length, os === "darwin" ? 12 : 11);
	});
}

const invalid = [
	["noninteractive substitute", (r) => { r.pty.interactive = false; }],
	["no original terminal", (r) => { delete r.pty.original; }],
	["uncooked terminal", (r) => { r.pty.after.icanon = false; }],
	["no raw TUI", (r) => { delete r.pty.rawObserved; }],
	["rescue CONT", (r) => { r.pty.noRescueCont = false; }],
	["missing stopped Pi", (r) => { r.paused.find((p) => p.role === "pi").state = "S"; }],
	["stopped guardian", (r) => { r.paused.find((p) => p.role === "guardian").state = "T"; }],
	["absent paused inventory", (r) => { delete r.paused; }],
	["false full exit", (r) => { r.allOwnedExited = false; }],
	["stopped outer survivor", (r) => { r.after.find((p) => p.pid === r.processes.outer.pid).state = "T"; }],
	["missing final state", (r) => { delete r.after[0].state; }],
	["wrong guardian parent", (r) => { r.processes.guardian.parent++; }],
	["wrong fault PID", (r) => { r.faultTargets[0].pid++; }],
	["wrong target", (r) => { r.target = "linux-arm64-gnu"; }],
	["wrong artifact", (r) => { r.cliSha256 = "f".repeat(64); }],
	["wrong runtime", (r) => { r.pi.bun = null; }],
	["foreign UID", (r) => { r.pi.uid++; }],
	["timeout", (r) => { r.postDeathMs = 8001; }],
	["missing timeout proof", (r) => { delete r.guardExpired; }],
	["PID fallback", (r) => { r.faultTargets[0].method = "kill"; }],
	["no birth", (r) => { delete r.faultTargets[0].birth; }],
	["moving paused heartbeat", (r) => { r.heartbeats.pauseEnd++; }],
	["continued heartbeat", (r) => { r.heartbeats.after++; }],
	["missing foreground job", (r) => { delete r.pty.jobForeground; }],
	["no positive paused peer", (r) => { delete r.peerPaused; }],
	["running peer at pause", (r) => { r.peerPaused.state = "S"; }],
	["resumed peer", (r) => { r.peerStoppedAfter = false; }],
	["peer heartbeat CONT", (r) => { r.heartbeats.peerAfter++; }],
	["unbound peer", (r) => { r.peer.group++; }],
];
for (const [label, mutate] of invalid) test(`PTY assertion rejects ${label}`, () => {
	const row = proof("linux"); mutate(row);
	assert.throws(() => verify(row), /owner lifecycle PTY/);
});
for (const [label, mutate] of [
	["missing observer", (r) => { delete r.processes.observer; }],
	["stopped observer", (r) => { r.paused.find((p) => p.role === "observer").state = "T"; }],
	["same-group observer", (r) => { r.processes.observer.group = r.processes.outer.group; }],
	["wrong observer parent", (r) => { r.processes.observer.parent = r.processes.guardian.pid; }],
	["unreaped observer", (r) => { r.after.find((p) => p.pid === r.processes.observer.pid).state = "Z"; }],
	["missing normal reap", (r) => { delete r.observerReaped; }],
	["non-native observer", (r) => { delete r.observerNative; }],
]) test(`Darwin assertion rejects ${label} on normal and fault teardown`, () => {
	for (const name of ["suspend-resume", ...unixOwnerFaultRows("darwin")]) {
		const row = proof("darwin", name); mutate(row);
		assert.throws(() => verify(row, "darwin"), /owner lifecycle PTY/);
	}
});

for (const [label, mutate] of [
	["missing anchor", (r) => { delete r.processes.anchor; }],
	["foreground anchor", (r) => { r.processes.anchor.group = r.processes.outer.group; }],
	["different-SID anchor", (r) => { r.processes.anchor.sid++; }],
	["stopped anchor", (r) => { r.paused.find((p) => p.role === "anchor").state = "T"; }],
	["anchor not R/S", (r) => { r.paused.find((p) => p.role === "anchor").state = "D"; }],
	["unreaped anchor", (r) => { r.after.find((p) => p.pid === r.processes.anchor.pid).state = "Z"; }],
	["absent anchor reap", (r) => { delete r.anchorReaped; }],
	["non-native anchor", (r) => { delete r.anchorNative; }],
	["extra outer child", (r) => { r.sessionChildren.outer.push(999); }],
	["missing anchor child inventory", (r) => { delete r.sessionChildren.anchor; }],
	["wrong guardian chain", (r) => { r.processes.guardian.parent = r.processes.outer.pid; }],
	["init-adopted grandchild", (r) => { r.adoption.postExitParent = r.processes.adoptedGrandchild.parent = 1; }],
	["unknown adopter", (r) => { r.adoption.postExitParent = r.processes.adoptedGrandchild.parent = 999; }],
]) test(`kernel-reaper assertion rejects ${label} on every normal/fault row`, () => {
	for (const os of ["linux", "freebsd"]) for (const name of ["suspend-resume", ...unixOwnerFaultRows(os)]) {
		const row = proof(os, name); mutate(row);
		assert.throws(() => verify(row, os), /owner lifecycle PTY/);
	}
});
for (const [label, mutate] of [
	["missing direct child", (r) => { delete r.processes.extensionChild; }],
	["surviving direct child", (r) => { r.after.find((p) => p.pid === r.processes.extensionChild.pid).state = "S"; }],
	["surviving adopted grandchild", (r) => { r.after.find((p) => p.pid === r.processes.adoptedGrandchild.pid).state = "T"; }],
	["unreaped direct child", (r) => { r.after.find((p) => p.pid === r.processes.extensionChild.pid).state = "Z"; }],
	["unreaped adopted grandchild", (r) => { r.after.find((p) => p.pid === r.processes.adoptedGrandchild.pid).state = "Z"; }],
	["missing adopted grandchild", (r) => { delete r.processes.adoptedGrandchild; }],
	["missing SID", (r) => { delete r.processes.adoptedGrandchild.sid; }],
	["grandchild not setsid", (r) => { r.adoption.grandchildBefore.sid = r.processes.pi.sid; }],
	["missing spawner birth", (r) => { delete r.adoption.spawner.birth; }],
	["unreaped spawner", (r) => { r.adoption.spawnerReaped = false; }],
	["zombie spawner", (r) => { r.adoption.spawnerState = "Z"; }],
	["missing spawner exit", (r) => { delete r.adoption.spawnerExit; }],
	["wrong spawner exit birth", (r) => { r.adoption.spawnerExit.birth = "reused"; }],
	["wrong pre-adoption ancestry", (r) => { r.adoption.grandchildBefore.parent++; }],
	["missing descendant heartbeat", (r) => { delete r.descendantHeartbeats.extensionChild; }],
	["continued grandchild heartbeat", (r) => { r.descendantHeartbeats.adoptedGrandchild.after++; }],
]) test(`extension-descendant assertion rejects ${label}`, () => {
	for (const os of ["linux", "freebsd", "darwin"]) {
		const row = proof(os); mutate(row);
		assert.throws(() => verify(row, os), /owner lifecycle PTY/);
	}
});
for (const key of ["spawner", "grandchildBefore", "spawnerExit", "spawnerState", "spawnerReaped", "postExitParent", "observationCycle"]) test(`adoption proof requires ${key}`, () => {
	for (const os of ["linux", "freebsd", "darwin"]) {
		const row = proof(os); delete row.adoption[key];
		assert.throws(() => verify(row, os), /owner lifecycle PTY/);
	}
});
for (const key of ["pid", "birth", "code", "signal"]) test(`reaped spawner exit proof requires ${key}`, () => {
	const row = proof("linux"); delete row.adoption.spawnerExit[key];
	assert.throws(() => verify(row), /spawner not reaped/);
});
for (const key of ["input", "grandchildPaused", "spawnerPaused", "grandchildResumed", "spawnerResumed", "heartbeatPauseStart", "heartbeatPauseEnd", "heartbeatResumed", "stableMs"]) test(`Darwin adoption requires observation-cycle ${key}`, () => {
	const row = proof("darwin"); delete row.adoption.observationCycle[key];
	assert.throws(() => verify(row, "darwin"), /observed-before-adoption/);
});
test("both kernel session reapers may adopt the pinned grandchild", () => {
	for (const os of ["linux", "freebsd"]) {
		const row = proof(os);
		row.adoption.postExitParent = row.processes.adoptedGrandchild.parent = row.processes.anchor.pid;
		row.paused.find((p) => p.role === "adoptedGrandchild").parent = row.processes.anchor.pid;
		row.sessionChildren.anchor.push(row.processes.adoptedGrandchild.pid);
		row.sessionChildren.anchor.sort((a, b) => a - b);
		verify(row, os);
	}
});
for (const [label, mutate] of [
	["missing entry record", (r) => { delete r.shutdownHook; }],
	["absent entered", (r) => { delete r.shutdownHook.entered; }],
	["no entry", (r) => { r.shutdownHook.entered = false; r.shutdownHook.pid = null; }],
	["absent PID", (r) => { delete r.shutdownHook.pid; }],
	["wrong Pi PID", (r) => { r.shutdownHook.pid++; }],
	["absent timing proof", (r) => { delete r.shutdownHook.enteredBeforeFault; }],
	["pre-fault entry", (r) => { r.shutdownHook.enteredBeforeFault = true; }],
]) test(`required shutdown hook rejects ${label}`, () => {
	for (const os of ["linux", "freebsd", "darwin"]) for (const name of ["paused-guardian-death", "paused-both-owners-death", "paused-both-owners-death-shutdown-blocked"]) {
		const row = proof(os, name); mutate(row);
		assert.throws(() => verify(row, os), /shutdown-hook entry/);
	}
});
test("optional shutdown hook entry is recorded without requiring it", () => {
	for (const os of ["linux", "freebsd", "darwin"]) for (const name of ["suspend-resume", "paused-outer-death", os === "darwin" ? "paused-observer-death" : "paused-anchor-death"]) {
		const row = proof(os, name);
		row.shutdownHook = { entered: false, enteredBeforeFault: false, pid: null }; verify(row, os);
		row.shutdownHook = { entered: true, enteredBeforeFault: false, pid: row.pi.pid }; verify(row, os);
		delete row.shutdownHook;
		assert.throws(() => verify(row, os), /shutdown-hook entry/);
	}
});

for (const [key, value] of [["armed", false], ["entered", false], ["returned", true], ["enteredBeforeFault", true], ["pid", 999], ["waitMs", 11999]]) test(`compiled deadline proof rejects shutdown-block ${key}`, () => {
	const row = proof("linux", "paused-both-owners-death-shutdown-blocked"); row.shutdownBlock[key] = value;
	assert.throws(() => verify(row), /worker deadline/);
});
for (const key of ["armed", "entered", "returned", "enteredBeforeFault", "pid", "waitMs"]) test(`compiled deadline proof requires shutdown-block ${key}`, () => {
	const row = proof("linux", "paused-both-owners-death-shutdown-blocked"); delete row.shutdownBlock[key];
	assert.throws(() => verify(row), /worker deadline/);
});
test("shutdown hook trigger must be off outside dedicated blocked row", () => {
	for (const name of ["suspend-resume", ...unixOwnerFaultRows("linux")].filter((n) => !n.endsWith("shutdown-blocked"))) {
		const row = proof("linux", name); row.shutdownBlock.armed = true;
		assert.throws(() => verify(row), /worker deadline/);
	}
});

test("shutdown fixture leaves normal quit unblocked and enters real main-thread Atomics.wait only when armed", async () => {
	const root = mkdtempSync(join(tmpdir(), "owner-shutdown-block-"));
	const script = join(root, "hook.mjs");
	writeFileSync(script, `import extension from ${JSON.stringify(new URL("./fixtures/owner/extension.mjs", import.meta.url).href)};
const handlers = new Map();
await extension({ on: (name, handler) => handlers.set(name, handler) });
process.on("message", () => { handlers.get("session_shutdown")(); process.send("returned"); });
process.send("ready");
`);
	const child = spawn(process.execPath, [script], { env: { ...process.env, PI_OWNER_CASE: "pty", PI_OWNER_PTY_WORK: root }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
	const ended = once(child, "exit").then(() => { throw new Error("shutdown fixture exited before message"); });
	const guard = setTimeout(() => child.kill("SIGKILL"), 8000);
	try {
		assert.equal((await Promise.race([once(child, "message"), ended]))[0], "ready");
		const off = Promise.race([once(child, "message"), ended]); child.send("shutdown");
		assert.equal((await off)[0], "returned");
		assert.deepEqual(JSON.parse(readFileSync(join(root, "shutdown-hook-entered"), "utf8")), { pid: child.pid });
		assert.equal(existsSync(join(root, "shutdown-entered")), false);
		rmSync(join(root, "shutdown-hook-entered"));
		writeFileSync(join(root, "shutdown-arm"), "arm");
		child.send("shutdown");
		const deadline = Date.now() + 5000;
		while (!existsSync(join(root, "shutdown-entered"))) { assert.ok(Date.now() < deadline, "shutdown fixture did not enter"); await delay(10); }
		assert.deepEqual(JSON.parse(readFileSync(join(root, "shutdown-hook-entered"), "utf8")), { pid: child.pid });
		const marker = JSON.parse(readFileSync(join(root, "shutdown-entered"), "utf8"));
		assert.equal(marker.pid, child.pid); assert.ok(marker.waitMs >= 12000);
		await delay(100);
		assert.equal(child.exitCode, null);
		assert.equal(existsSync(join(root, "shutdown-returned")), false);
	} finally {
		clearTimeout(guard);
		if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; }
		rmSync(root, { recursive: true, force: true });
	}
});

test("normal PTY resume still requires clean exit, not merely containment", () => {
	for (const exit of [undefined, { code: 1, signal: null }, { code: null, signal: 15 }]) {
		const row = proof("linux", "suspend-resume"); row.exit = exit;
		assert.throws(() => verify(row), /normal fg\/Ctrl-D exit was not clean/);
	}
});

test("Unix identity rejects root, missing credentials, elevated groups and capabilities", () => {
	for (const [key, value] of [["uid", 0], ["euid", 0], ["gid", 0], ["egid", 0], ["groups", [0]], ["groupNames", ["docker"]], ["rootEquivalentGroup", true], ["capabilities", { CapPrm: "1", CapEff: "0", CapAmb: "0" }]]) {
		assert.throws(() => assertNonadminIdentity({ ...identity, [key]: value }, "linux"), /nonadmin identity/);
	}
	assert.throws(() => assertNonadminIdentity({ elevated: false }, "linux"), /nonadmin identity/);
});

test("owner aggregation cannot hide failed/absent PTY rows behind passed status", () => {
	const rows = ownerLifecycleRows("linux").map((name) => isUnixOwnerPtyRow(name) ? proof("linux", name) : { name, status: "passed", pi: { bun: "1.3.14" }, aliveBefore: true, aliveAfter: false, peerAlive: true, immediateChecks: 1, ownershipDisabled: true });
	const evidence = { status: "passed", target: descriptor.id, cliSha256: digest, identity, rows, ...artifactBunFromOwnerRows(rows) };
	assertOwnerLifecycle(evidence, "linux");
	for (const name of unixOwnerFaultRows("linux")) {
		const changed = structuredClone(evidence);
		changed.rows.find((r) => r.name === name).allOwnedExited = false;
		assert.throws(() => assertOwnerLifecycle(changed, "linux"), /full teardown/);
		changed.rows = changed.rows.filter((r) => r.name !== name);
		assert.throws(() => assertOwnerLifecycle(changed, "linux"), /inventory/);
	}
});

test("missing or non-native PTY harness fails closed", () => {
	const root = mkdtempSync(join(tmpdir(), "owner-pty-negative-"));
	try {
		assert.equal(smokeUnixOwnerPty(process.execPath, descriptor, "paused-guardian-death", root, identity, { harness: "" }).status, "failed");
		assert.equal(smokeUnixOwnerPty(process.execPath, descriptor, "paused-guardian-death", root, identity, { harness: process.execPath }).status, "failed");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("CI PTY builder uses existing locked manifest and matching target, never ships helper", () => {
	const root = mkdtempSync(join(tmpdir(), "owner-pty-build-test-"));
	try {
		const source = join(root, "example"); writeFileSync(source, "native fixture bytes");
		const output = join(root, "stage", "owner-pty");
		const calls = [];
		buildOwnerPty(descriptor.id, output, { env: { CI: "true", CARGO_TARGET_DIR: join(root, "target") }, run: (command, args, options) => {
			calls.push({ command, args, options });
			return { status: 0, stdout: JSON.stringify({ reason: "compiler-artifact", target: { name: "owner-pty", kind: ["example"] }, executable: source }) };
		} });
		assert.equal(calls[0].command, "rustup"); assert.ok(calls[0].args.includes("1.96.0"));
		assert.equal(calls[1].command, "cargo");
		for (const arg of ["--locked", "--example", "owner-pty", descriptor.cargoTarget]) assert.ok(calls[1].args.includes(arg));
		assert.equal(readFileSync(output, "utf8"), "native fixture bytes");
		assert.equal(calls[1].options.env.RUSTUP_AUTO_INSTALL, "0");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
