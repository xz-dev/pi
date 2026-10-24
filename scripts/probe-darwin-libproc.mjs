#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModulePath } from "./lib/bun-targets.mjs";
import { assertNonadminIdentity } from "./smoke-owner-lifecycle.mjs";

export function assertFact(record, uid, groupNames) {
	const keys = (value, names) => assert.deepEqual(Object.keys(value).sort(), [...names].sort());
	const integer = (value) => assert(Number.isSafeInteger(value) && value >= 0);
	keys(record, ["diagnosticOnly", "publishable", "identity", "psFile", "children", "complete"]);
	assert.equal(record.diagnosticOnly, true); assert.equal(record.publishable, false); assert.equal(record.complete, true);
	keys(record.identity, ["pid", "parent", "uid", "euid", "gid", "egid", "groups"]);
	for (const name of ["pid", "parent", "uid", "euid", "gid", "egid"]) integer(record.identity[name]);
	assert(record.identity.pid > 1 && record.identity.parent > 1);
	assert.equal(record.identity.uid, uid); assert.equal(record.identity.euid, uid);
	assertNonadminIdentity({ ...record.identity, groupNames, elevated: false }, "darwin");
	keys(record.psFile, ["mode", "uid", "gid", "setuid"]);
	for (const name of ["mode", "uid", "gid"]) integer(record.psFile[name]);
	assert.equal(typeof record.psFile.setuid, "boolean");
	assert.equal(record.psFile.setuid, (record.psFile.mode & 0o4000) !== 0);
	assert.equal(record.children.length, 2);
	assert.deepEqual(record.children.map((child) => child.kind), ["control", "ps"]);
	assert.notEqual(record.children[0].pid, record.children[1].pid);
	for (const child of record.children) {
		keys(child, ["kind", "pid", "heldDirectChild", "stableLiveSample", "sampleMs", "drainedBytes", "reaped", "cleanupKilled", "waitStatus", "before", "full", "after"]);
		integer(child.pid); assert(child.pid > 1); assert.equal(child.heldDirectChild, true);
		assert.equal(child.stableLiveSample, true); assert.equal(child.reaped, true); assert.equal(child.cleanupKilled, false); assert.equal(child.waitStatus, 0);
		assert(Number.isFinite(child.sampleMs) && child.sampleMs >= 0 && child.sampleMs < 2500);
		integer(child.drainedBytes); assert(child.drainedBytes > 65536 && child.drainedBytes <= 1048576);
		for (const name of ["before", "after"]) {
			keys(child[name], ["returned", "errno", "expectedBytes", "pid", "parent", "group", "state", "uid", "ruid", "svuid"]);
			for (const value of Object.values(child[name])) integer(value);
			assert.equal(child[name].returned, child[name].expectedBytes); assert(child[name].expectedBytes > 0);
			assert.equal(child[name].errno, 0); assert.equal(child[name].pid, child.pid); assert.equal(child[name].parent, record.identity.pid);
			assert.notEqual(child[name].state, 5);
		}
		for (const name of ["uid", "ruid", "svuid", "group"]) assert.equal(child.before[name], child.after[name]);
		for (const key of ["returned", "errno", "expectedBytes"]) integer(child.full[key]);
		assert(child.full.expectedBytes > 0);
		if (child.full.returned === child.full.expectedBytes) {
			keys(child.full, ["returned", "errno", "expectedBytes", "pid", "uid", "ruid", "startSeconds", "startMicros"]);
			for (const value of Object.values(child.full)) integer(value);
			assert.equal(child.full.errno, 0); assert.equal(child.full.pid, child.pid); assert.equal(child.full.uid, child.before.uid);
			assert.equal(child.full.ruid, child.before.ruid); assert(child.full.startMicros < 1000000);
		} else {
			keys(child.full, ["returned", "errno", "expectedBytes"]);
			assert.equal(child.full.returned, 0); assert(child.full.errno > 0);
		}
	}
	const control = record.children[0];
	assert.equal(control.before.uid, uid); assert.equal(control.full.returned, control.full.expectedBytes);
	return record;
}

export function assertFactContext(env, platform) {
	assert.equal(platform, "darwin"); assert.equal(env.GITHUB_ACTIONS, "true");
	assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch"); assert.equal(env.GITHUB_REPOSITORY, "xz-dev/pi");
	assert(/^refs\/heads\/diagnostic\/.+/.test(env.GITHUB_REF ?? ""));
}

function run(binary, output) {
	assertFactContext(process.env, process.platform);
	assert.equal(dirname(resolve(output)), resolve(process.env.RUNNER_TEMP));
	assert.equal(basename(output), "DIAGNOSTIC-darwin-libproc.json");
	const fd = openSync(output, "wx", 0o600);
	const user = "pi-libproc-fact";
	let root, rootIdentity, created = false, password;
	const report = { diagnosticOnly: true, publishable: false, status: "failed", workflowSha: process.env.GITHUB_SHA };
	const command = (file, args) => {
		const result = spawnSync(file, args, { encoding: "utf8", timeout: 120000, cwd: "/" });
		if (result.status !== 0) throw new Error(`${file}: ${String(result.stderr || result.error?.message || result.status).replaceAll(password ?? "\0", "<redacted>")}`);
		return result.stdout.trim();
	};
	try {
		assert.equal(spawnSync("id", ["-u", user], { timeout: 10000 }).status, 1, "dedicated account must not exist");
		root = mkdtempSync("/Users/Shared/pi-libproc-fact-"); chmodSync(root, 0o755); rootIdentity = lstatSync(root, { bigint: true });
		copyFileSync(binary, join(root, "fact")); chmodSync(join(root, "fact"), 0o755);
		report.programSha256 = createHash("sha256").update(readFileSync(join(root, "fact"))).digest("hex");
		password = `Pi!9${randomBytes(8).toString("base64url").slice(0, 10)}`;
		command("sudo", ["-n", "sysadminctl", "-addUser", user, "-password", password, "-home", join(root, "home"), "-shell", "/bin/sh"]); created = true;
		const uid = Number(command("id", ["-u", user])); assert(Number.isSafeInteger(uid) && uid > 0);
		const groupNames = command("id", ["-Gn", user]).split(/\s+/);
		const result = spawnSync("sudo", ["-n", "-u", user, "-H", "env", "-i", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", `HOME=${join(root, "home")}`, "LC_ALL=C", join(root, "fact")], { encoding: "utf8", timeout: 20000, maxBuffer: 262144, cwd: "/" });
		report.childExit = result.status; report.childSignal = result.signal; report.childError = result.error?.message ?? null;
		report.stderr = String(result.stderr ?? "").slice(-4096);
		report.stdout = String(result.stdout ?? "").slice(0, 16384);
		report.launcherPid = result.pid;
		const raw = JSON.parse(result.stdout);
		assert.equal(result.status, 0, "fact capture incomplete; inspect bounded child evidence");
		const checked = assertFact(raw, uid, groupNames);
		report.identity = { ...checked.identity, groupNames, elevated: false };
		report.psFile = checked.psFile; report.children = checked.children;
		report.status = "captured";
	} catch (error) { report.error = error.message; }
	finally {
		const cleanup = [];
		if (created) { try { command("sudo", ["-n", "sysadminctl", "-deleteUser", user, "-keepHome"]); } catch (error) { cleanup.push(error.message); } }
		if (root) {
			try {
				const current = lstatSync(root, { bigint: true });
				assert(current.isDirectory() && current.dev === rootIdentity.dev && current.ino === rootIdentity.ino && current.uid === rootIdentity.uid && (current.mode & 0o777n) === 0o755n);
				command("sudo", ["-n", "rm", "-rf", root]);
			} catch (error) { cleanup.push(error.message); }
		}
		if (cleanup.length) { report.cleanupErrors = cleanup; report.status = "failed"; }
		assert(fstatSync(fd).isFile()); writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`); closeSync(fd);
	}
	if (report.status !== "captured") throw new Error(report.error || report.cleanupErrors?.join("; ") || "fact capture failed");
}
if (process.argv[1] && isMainModulePath(fileURLToPath(import.meta.url), process.argv[1])) {
	try { run(process.argv[2], process.argv[3]); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
