import assert from "node:assert/strict";
import test from "node:test";
import { passedUnixIdentity, passedUnixOwnerPtyRow } from "./fixtures/unix-owner-pty.mjs";
import { assertUnixOwnerPtyRow } from "./smoke-unix-owner-pty.mjs";

const identity = passedUnixIdentity();
const target = "freebsd-arm64";
const digest = "d".repeat(64);
const proof = () => passedUnixOwnerPtyRow("paused-outer-backup-death", "freebsd", target, digest);
const verify = (row) => assertUnixOwnerPtyRow(row, "freebsd", identity, target, digest);

test("exported FreeBSD D readiness remains rejected by unchanged R/S validator", () => {
	const row = proof();
	verify(row);
	row.processes.anchor.state = "Ds";
	assert.throws(() => verify(row), /runnable\/outside-group native anchor/);
});

test("controller state stays independent; controller FD and paused R/S failures remain strict", () => {
	const row = proof();
	row.controllers.anchor.state = "D";
	verify(row);
	assert.match(row.processes.anchor.state, /^[RS]/);
	row.controllers.anchor.fds.complete = false;
	assert.throws(() => verify(row), /native FD provenance/);
	const paused = proof();
	paused.paused.find(({ role }) => role === "anchor").state = "Ds";
	assert.throws(() => verify(paused), /missing positive paused\/runnable anchor/);
});
