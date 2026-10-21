import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		assert.equal(ownerLifecycleRows(os).length, os === "darwin" ? 10 : 8);
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
