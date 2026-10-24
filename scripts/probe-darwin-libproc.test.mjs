import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { assertFact, assertFactContext } from "./probe-darwin-libproc.mjs";

const source = () => readFileSync(new URL("./fixtures/darwin-libproc-fact.c", import.meta.url), "utf8");
const fixture = () => {
	const identity = { pid: 101, parent: 100, uid: 502, euid: 502, gid: 20, egid: 20, groups: [20] };
	const children = [201, 202].map((pid, index) => {
		const uid = index ? 0 : 502;
		const short = { returned: 68, errno: 0, expectedBytes: 68, pid, parent: 101, group: 200, state: 2, uid, ruid: 502, svuid: uid };
		const bsd = { result: 0, errno: 0, returnedBytes: 648, expectedBytes: 648, pid, parent: 101, group: 200, state: 2, uid, ruid: 502, svuid: uid, startSeconds: 1792811227, startMicros: 12345 };
		return { kind: index ? "ps" : "control", pid, heldDirectChild: true, stableLiveSample: true, sampleMs: 4, drainedBytes: 98308, reaped: true, cleanupKilled: false, waitStatus: 0, before: { ...short }, after: { ...short }, full: index ? { returned: 0, errno: 1, expectedBytes: 136 } : { returned: 136, errno: 0, expectedBytes: 136, pid, uid, ruid: 502, startSeconds: 1792811227, startMicros: 12345 }, bsd };
	});
	return { diagnosticOnly: true, publishable: false, complete: true, identity, psFile: { mode: 0o104755, uid: 0, gid: 0, setuid: true }, children };
};

test("fact captures cross-UID EPERM without turning it into product acceptance", () => {
	const record = fixture();
	assert.equal(assertFact(record, 502, ["staff"]), record);
	assert.equal(record.publishable, false);
});

test("fact remains falsifiable when ps is same UID and full query succeeds", () => {
	const record = fixture();
	record.psFile = { mode: 0o100755, uid: 0, gid: 0, setuid: false };
	const ps = record.children[1];
	ps.before.uid = ps.after.uid = ps.before.svuid = ps.after.svuid = ps.bsd.uid = ps.bsd.svuid = 502;
	ps.full = { ...record.children[0].full, pid: ps.pid };
	assert.doesNotThrow(() => assertFact(record, 502, ["staff"]));
});

test("BSD birth capability remains falsifiable for denied, absent and partial ps records", () => {
	for (const bsd of [
		{ result: -1, errno: 1, returnedBytes: 648, expectedBytes: 648 },
		{ result: 0, errno: 0, returnedBytes: 0, expectedBytes: 648 },
		{ result: 0, errno: 0, returnedBytes: 16, expectedBytes: 648 },
	]) {
		const record = fixture(); record.children[1].bsd = bsd;
		assert.doesNotThrow(() => assertFact(record, 502, ["staff"]));
	}
});

test("BSD records require exact identities and successful control birth parity", () => {
	for (const mutate of [
		(r) => { r.children[0].bsd.startMicros++; },
		(r) => { r.children[0].bsd = { result: -1, errno: 1, returnedBytes: 648, expectedBytes: 648 }; },
		(r) => { r.children[1].bsd.pid++; },
		(r) => { r.children[1].bsd.parent++; },
		(r) => { r.children[1].bsd.group++; },
		(r) => { r.children[1].bsd.uid = 502; },
		(r) => { r.children[1].bsd.startSeconds = 0; },
		(r) => { r.children[1].bsd.startMicros = 1000000; },
		(r) => { r.children[1].bsd.state = 5; },
		(r) => { r.children[1].bsd.extra = true; },
	]) {
		const record = fixture(); mutate(record);
		assert.throws(() => assertFact(record, 502, ["staff"]));
	}
});

test("invalid identity, unstable samples, missing cleanup and arbitrary keys fail closed", () => {
	for (const mutate of [
		(r) => { r.identity.uid = r.identity.euid = 0; },
		(r) => { r.children[0].full = { returned: 0, errno: 1, expectedBytes: 136 }; },
		(r) => { r.children[1].before.parent = 999; },
		(r) => { r.children[1].after.pid = 999999; },
		(r) => { r.children[1].after.uid = 502; },
		(r) => { r.children[1].reaped = false; },
		(r) => { r.children[1].cleanupKilled = true; },
		(r) => { r.children[1].before.returned = 0; },
		(r) => { r.children[1].after.state = 5; },
		(r) => { r.children[1].drainedBytes = 0; },
		(r) => { r.children[1].full = { returned: 3, errno: 0, expectedBytes: 136 }; },
		(r) => { r.private = "not accepted"; },
	]) {
		const record = fixture(); mutate(record);
		assert.throws(() => assertFact(record, 502, ["staff"]));
	}
	assert.throws(() => assertFact(fixture(), 502, ["staff", "admin"]));
});

test("route is manual diagnostic namespace only and leaves old step bodies unchanged", () => {
	const workflow = parse(readFileSync(new URL("../.github/workflows/probe-windows-rename.yml", import.meta.url), "utf8"));
	const parent = parse(execFileSync("git", ["show", "c86e4b837c065fa7471d46f689693e0f0e53e7c9:.github/workflows/probe-windows-rename.yml"], { encoding: "utf8" }));
	assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
	assert.equal(workflow.on.workflow_dispatch.inputs.darwin_libproc_fact.default, false);
	const fact = workflow.jobs["fact-darwin-libproc"];
	assert.equal(fact["runs-on"], "macos-15-intel"); assert.equal(fact["timeout-minutes"], 10);
	assert.deepEqual(fact.permissions, { contents: "read" });
	assert.match(fact.if, /github.repository == 'xz-dev\/pi'/); assert.match(fact.if, /refs\/heads\/diagnostic\//);
	assert(!fact.steps.some((s) => /npm (ci|install)|bun build|build-binaries|publish|attest|lifecycle/.test(s.run ?? "")));
	delete workflow.jobs["fact-darwin-libproc"];
	delete workflow.on.workflow_dispatch.inputs.darwin_libproc_fact;
	workflow.jobs["probe-windows-rename"].if = parent.jobs["probe-windows-rename"].if;
	workflow.jobs["diagnose-macos-candidate"].if = parent.jobs["diagnose-macos-candidate"].if;
	assert.deepEqual(workflow, parent);
});

test("runtime entry gate rejects main, other repos, platforms and events", () => {
	const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "xz-dev/pi", GITHUB_REF: "refs/heads/diagnostic/native-libproc" };
	assert.doesNotThrow(() => assertFactContext(env, "darwin"));
	for (const change of [{ GITHUB_REF: "refs/heads/main" }, { GITHUB_REF: "refs/heads/diagnostic/" }, { GITHUB_REPOSITORY: "other/pi" }, { GITHUB_EVENT_NAME: "push" }, { GITHUB_ACTIONS: "false" }]) assert.throws(() => assertFactContext({ ...env, ...change }, "darwin"));
	assert.throws(() => assertFactContext(env, "linux"));
});

test("native fact only queries held children and never stops or globally enumerates processes", () => {
	const text = source();
	assert.match(text, /proc_pidinfo\(pid, PROC_PIDT_SHORTBSDINFO/);
	assert.doesNotMatch(text, /PROC_PIDUNIQIDENTIFIERINFO/);
	assert.match(text, /proc_pidinfo\(pid, PROC_PIDTBSDINFO/);
	assert.match(text, /CTL_KERN, KERN_PROC, KERN_PROC_PID, pid/);
	assert.match(text, /sysctl\(name, 4, &value->bsd, &value->bsd_n, NULL, 0\)/);
	assert.match(text, /"-p", self, "-o", header/);
	assert.match(text, /alarm\(8\)/);
	assert.match(text, /if \(!reaped && held\)/);
	assert.doesNotMatch(text, /SIGSTOP|SIGCONT|ptrace|proc_list(?:all|child|pgrp|pids)|set(?:e?uid|gid)\(/);
	assert.match(text, /getuid\(\) == 0 \|\| geteuid\(\) == 0/);
	const runner = readFileSync(new URL("./probe-darwin-libproc.mjs", import.meta.url), "utf8");
	assert.match(runner, /openSync\(output, "wx", 0o600\)/);
	assert.match(runner, /writeFileSync\(fd,/);
	assert.match(runner, /"env", "-i"/);
	assert.match(runner, /current\.ino === rootIdentity\.ino/);
});
