import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const unixOwnerFaultRows = (os) => ["paused-guardian-death", "paused-both-owners-death", ...(os === "darwin" ? ["paused-observer-death"] : [])];
export const isUnixOwnerPtyRow = (name) => name === "suspend-resume" || name.startsWith("paused-");
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const pid = (n) => Number.isSafeInteger(n) && n > 1;
const count = (n) => Number.isSafeInteger(n) && n >= 0;
const stopped = (state) => typeof state === "string" && /^T/.test(state);
const runnable = (state) => typeof state === "string" && /^[RSIDU]/.test(state);
const dead = (state) => state === "gone" || (typeof state === "string" && /^Z/.test(state));

export function assertUnixOwnerPtyRow(row, os, identity, targetId, cliSha256) {
	const fail = (reason) => { throw new Error(`owner lifecycle PTY ${row.name}: ${reason}`); };
	if (row.target !== targetId || row.cliSha256 !== cliSha256 || !/^[a-f0-9]{64}$/.test(row.cliSha256 ?? "")) fail("artifact/target binding missing");
	if (row.identity?.uid !== identity.uid || row.identity?.euid !== identity.euid || row.pi?.uid !== identity.uid || identity.uid <= 0) fail("nonadmin UID binding missing");
	if (typeof row.pi?.bun !== "string" || !row.pi.bun.trim() || typeof row.pi.owner !== "string" || !row.pi.owner.trim()) fail("shipped Bun/native owner missing");
	const tty = row.pty;
	if (tty?.harness !== "native-openpty" || tty.interactive !== true || tty.input !== "ctrl-z" || tty.rawObserved !== true || tty.jobForeground !== true || tty.noRescueCont !== true || tty.shellForeground !== true || tty.shellAlive !== true) fail("actual interactive PTY/no-rescue proof missing");
	for (const key of ["isig", "icanon", "echo"]) if (tty.original?.[key] !== true || tty.after?.[key] !== true) fail("original/restored cooked terminal missing");
	for (const stage of ["original", "after"]) for (const flag of ["lflag", "iflag", "oflag", "cflag"]) if (!count(tty[stage]?.[flag])) fail("terminal state incomplete");
	const roles = ["outer", "guardian", "pi", "taskOuter", "taskGuardian", "payload", "leaf", ...(os === "darwin" ? ["observer"] : [])];
	if (JSON.stringify(Object.keys(row.processes ?? {}).sort()) !== JSON.stringify([...roles].sort())) fail("owned role inventory missing");
	const p = row.processes;
	for (const role of roles) {
		const v = p[role];
		if (!pid(v.pid) || !pid(v.parent) || !pid(v.group) || v.uid !== identity.uid || typeof v.birth !== "string" || !v.birth || !runnable(v.state)) fail(`invalid pre-pause ${role} identity`);
	}
	if (new Set(roles.map((role) => p[role].pid)).size !== roles.length) fail("duplicate role PID");
	if (row.pi.pid !== p.pi.pid || row.pi.parent !== p.guardian.pid || p.pi.parent !== p.guardian.pid || p.guardian.parent !== p.outer.pid || p.taskOuter.parent !== p.pi.pid || p.taskGuardian.parent !== p.taskOuter.pid || p.payload.parent !== p.taskGuardian.pid || p.leaf.parent !== p.payload.pid) fail("wrong owner/task ancestry");
	if (p.pi.group !== p.outer.group || p.outer.group !== p.outer.pid || p.taskOuter.group === p.outer.group) fail("wrong foreground/task groups");
	if (os === "darwin" && (p.observer.parent !== p.outer.pid || p.observer.group === p.outer.group || p.observer.group === p.taskOuter.group || row.observerReaped !== true || row.observerNative !== true)) fail("runnable/outside-group native observer/reaping proof missing");
	if (!Array.isArray(row.paused) || row.paused.length !== roles.length || new Set(row.paused.map((v) => v.role)).size !== roles.length) fail("paused inventory missing");
	for (const role of roles) {
		const v = row.paused.find((v) => v.role === role);
		if (!v || ["pid", "parent", "group", "birth", "uid"].some((key) => v[key] !== p[role][key]) || (["guardian", "observer"].includes(role) ? !runnable(v.state) : !stopped(v.state))) fail(`missing positive paused/runnable ${role} observation`);
	}
	const peer = row.peer;
	if (!pid(peer?.pid) || peer.pid === p.outer.pid || peer.parent !== p.outer.parent || peer.group !== p.outer.group || peer.uid !== identity.uid || typeof peer.birth !== "string" || !peer.birth || !runnable(peer.state)) fail("unowned same-job-group sibling missing");
	if (!row.peerPaused || ["pid", "parent", "group", "birth", "uid"].some((key) => row.peerPaused[key] !== peer[key]) || !stopped(row.peerPaused.state)) fail("positive paused peer observation missing");
	const heartbeat = row.heartbeats;
	for (const key of ["before", "advancing", "pauseStart", "pauseEnd", "exit", "after", "peerPause", "peerAfter", "stableMs"]) if (!count(heartbeat?.[key])) fail("heartbeat observation missing");
	if (heartbeat.advancing <= heartbeat.before || heartbeat.pauseStart <= 0 || heartbeat.pauseEnd !== heartbeat.pauseStart || heartbeat.exit !== heartbeat.after || heartbeat.stableMs < 250 || heartbeat.peerPause <= 0) fail("heartbeat not advancing/stable at required boundaries");
	if (!count(row.postDeathMs) || row.postDeathMs > 8000 || row.guardExpired !== false || row.allOwnedExited !== true) fail("bounded full teardown missing");
	if (!Array.isArray(row.after) || row.after.length !== roles.length || new Set(row.after.map((v) => v.pid)).size !== roles.length) fail("post-exit inventory missing");
	for (const role of roles) {
		const v = row.after.find((v) => v.pid === p[role].pid);
		if (!v || v.birth !== p[role].birth || !dead(v.state) || (role === "observer" && v.state !== "gone")) fail(`owned ${role} survived/unreaped`);
	}
	if (row.name === "suspend-resume" && (row.resumed !== true || row.exit?.code !== 0 || row.exit?.signal !== null)) fail("normal fg/Ctrl-D exit was not clean");
	const faults = row.name === "suspend-resume" ? [] : row.name === "paused-both-owners-death" ? ["outer", "guardian"] : row.name === "paused-observer-death" ? ["observer"] : ["guardian"];
	if (JSON.stringify(row.faultTargets?.map((v) => v.role)) !== JSON.stringify(faults)) fail("fault inventory wrong");
	for (const v of row.faultTargets) if (["pid", "birth", "parent"].some((key) => v[key] !== p[v.role]?.[key]) || v.method !== (os === "linux" ? "pidfd" : "checked-birth")) fail("fault target birth/ancestry/pidfd proof missing");
	if (faults.length && (row.peerStoppedAfter !== true || heartbeat.peerAfter !== heartbeat.peerPause)) fail("unowned peer resumed by product");
}

export function smokeUnixOwnerPty(executable, target, name, work, identity, { harness = process.env.PI_OWNER_PTY_HARNESS } = {}) {
	if (!harness) return { name, status: "failed", error: "PI_OWNER_PTY_HARNESS must name the architecture-matched CI-only fixture" };
	mkdirSync(work, { recursive: true });
	const timeoutMs = target.emulated ? 180_000 : 60_000;
	const result = spawnSync(resolve(harness), ["--run", executable, fileURLToPath(new URL("./fixtures/owner/", import.meta.url)), work, name, String(timeoutMs)], { encoding: "utf8", timeout: timeoutMs + 20_000, maxBuffer: 1024 * 1024 });
	let row;
	try { row = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); }
	catch { row = { name, status: "failed", error: `PTY fixture missing evidence (${result.status ?? result.error?.message}): ${result.stderr?.slice(-4096)}` }; }
	Object.assign(row, { target: target.id, cliSha256: hash(executable) });
	try {
		if (result.status !== 0 || row.status !== "passed" || row.name !== name) throw new Error(row.error || `PTY fixture failed (${result.status ?? result.error?.message})`);
		assertUnixOwnerPtyRow(row, target.os, identity, target.id, hash(executable));
	} catch (error) { row.status = "failed"; row.error = error.message; }
	return row;
}
