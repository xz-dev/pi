import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const unixOwnerFaultRows = (os) => ["paused-outer-death", ...(os !== "darwin" ? ["paused-anchor-death"] : []), "paused-guardian-death", "paused-both-owners-death", "paused-both-owners-death-shutdown-blocked", ...(os === "darwin" ? ["paused-observer-death"] : [])];
export const isUnixOwnerPtyRow = (name) => name === "suspend-resume" || name.startsWith("paused-");
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const pid = (n) => Number.isSafeInteger(n) && n > 1;
const count = (n) => Number.isSafeInteger(n) && n >= 0;
const stopped = (state) => typeof state === "string" && /^T/.test(state);
const runnable = (state) => typeof state === "string" && /^[RSIDU]/.test(state);
const dead = (state) => state === "gone" || (typeof state === "string" && /^Z/.test(state));
const identityKeys = ["pid", "birth", "parent", "group", "sid", "uid"];
const matches = (observed, expected) => observed && expected && identityKeys.every((key) => observed[key] === expected[key]);

export function assertUnixOwnerPtyRow(row, os, identity, targetId, cliSha256) {
	const fail = (reason) => { throw new Error(`owner lifecycle PTY ${row.name}: ${reason}`); };
	if (row.target !== targetId || row.cliSha256 !== cliSha256 || !/^[a-f0-9]{64}$/.test(row.cliSha256 ?? "")) fail("artifact/target binding missing");
	if (row.identity?.uid !== identity.uid || row.identity?.euid !== identity.euid || row.pi?.uid !== identity.uid || identity.uid <= 0) fail("nonadmin UID binding missing");
	if (typeof row.pi?.bun !== "string" || !row.pi.bun.trim() || typeof row.pi.owner !== "string" || !row.pi.owner.trim()) fail("shipped Bun/native owner missing");
	const tty = row.pty;
	if (tty?.harness !== "native-openpty" || tty.interactive !== true || tty.input !== "ctrl-z" || tty.rawObserved !== true || tty.jobForeground !== true || tty.noRescueCont !== true || tty.shellForeground !== true || tty.shellAlive !== true) fail("actual interactive PTY/no-rescue proof missing");
	for (const key of ["isig", "icanon", "echo"]) if (tty.original?.[key] !== true || tty.after?.[key] !== true) fail("original/restored cooked terminal missing");
	for (const stage of ["original", "after"]) for (const flag of ["lflag", "iflag", "oflag", "cflag"]) if (!count(tty[stage]?.[flag])) fail("terminal state incomplete");
	const roles = ["outer", "guardian", "pi", "taskOuter", "taskGuardian", "payload", "leaf", "extensionChild", "adoptedGrandchild", os === "darwin" ? "observer" : "anchor"];
	if (JSON.stringify(Object.keys(row.processes ?? {}).sort()) !== JSON.stringify([...roles].sort())) fail("owned role inventory missing");
	const p = row.processes;
	for (const role of roles) {
		const v = p[role];
		const validParent = pid(v.parent) || os === "darwin" && role === "adoptedGrandchild" && v.parent === 1;
		if (!pid(v.pid) || !validParent || !pid(v.group) || !pid(v.sid) || v.uid !== identity.uid || typeof v.birth !== "string" || !v.birth || !runnable(v.state)) fail(`invalid pre-pause ${role} identity`);
	}
	if (new Set(roles.map((role) => p[role].pid)).size !== roles.length) fail("duplicate role PID");
	if (row.pi.pid !== p.pi.pid || row.pi.parent !== p.guardian.pid || p.pi.parent !== p.guardian.pid || p.guardian.parent !== (os === "darwin" ? p.outer.pid : p.anchor.pid) || p.taskOuter.parent !== p.pi.pid || p.taskGuardian.parent !== p.taskOuter.pid || p.payload.parent !== p.taskGuardian.pid || p.leaf.parent !== p.payload.pid || p.extensionChild.parent !== p.pi.pid) fail("wrong owner/task/extension ancestry");
	if (p.pi.group !== p.outer.group || p.outer.group !== p.outer.pid || p.taskOuter.group === p.outer.group || p.pi.sid !== p.outer.sid || p.extensionChild.sid !== p.pi.sid) fail("wrong foreground/task groups/session");
	const sessionChild = os === "darwin" ? [p.guardian.pid, p.observer.pid].sort((a, b) => a - b) : [p.anchor.pid];
	if (JSON.stringify(row.sessionChildren?.outer) !== JSON.stringify(sessionChild)) fail("outer direct-child inventory wrong");
	if (os !== "darwin" && (p.anchor.parent !== p.outer.pid || p.anchor.group === p.outer.group || p.anchor.sid !== p.outer.sid || !/^[RS]/.test(p.anchor.state) || row.anchorReaped !== true || row.anchorNative !== true || JSON.stringify(row.sessionChildren?.anchor) !== JSON.stringify([p.guardian.pid, ...(p.adoptedGrandchild.parent === p.anchor.pid ? [p.adoptedGrandchild.pid] : [])].sort((a, b) => a - b)))) fail("runnable/outside-group native anchor/reaping proof missing");
	if (os === "darwin" && (p.observer.parent !== p.outer.pid || p.observer.group === p.outer.group || p.observer.group === p.taskOuter.group || row.observerReaped !== true || row.observerNative !== true)) fail("runnable/outside-group native observer/reaping proof missing");
	const adoption = row.adoption;
	const spawner = adoption?.spawner;
	const before = adoption?.grandchildBefore;
	if (!pid(spawner?.pid) || roles.some((role) => p[role].pid === spawner.pid) || spawner.parent !== p.pi.pid || spawner.group !== p.pi.group || spawner.sid !== p.pi.sid || spawner.uid !== identity.uid || typeof spawner.birth !== "string" || !spawner.birth || !runnable(spawner.state) || !before || !runnable(before.state) || before.pid !== p.adoptedGrandchild.pid || before.birth !== p.adoptedGrandchild.birth || before.parent !== spawner.pid || before.uid !== identity.uid || before.sid !== before.pid || before.group !== before.pid || p.adoptedGrandchild.sid !== before.sid || p.adoptedGrandchild.group !== before.group) fail("pinned spawner/setsid grandchild proof missing");
	if (adoption.spawnerReaped !== true || adoption.spawnerState !== "gone" || adoption.spawnerExit?.pid !== spawner.pid || adoption.spawnerExit?.birth !== spawner.birth || adoption.spawnerExit?.code !== 0 || adoption.spawnerExit?.signal !== null || adoption.postExitParent !== p.adoptedGrandchild.parent) fail("spawner not reaped before pause/fault");
	if (os !== "darwin") {
		if (![p.guardian.pid, p.anchor.pid].includes(adoption.postExitParent) || adoption.observationCycle !== null) fail("grandchild not adopted by pinned session reaper");
	} else {
		const cycle = adoption.observationCycle;
		if (adoption.postExitParent !== 1 || cycle?.input !== "ctrl-z,fg" || !count(cycle.stableMs) || cycle.stableMs < 250 || !matches(cycle.grandchildPaused, before) || !matches(cycle.spawnerPaused, spawner) || !stopped(cycle.grandchildPaused.state) || !stopped(cycle.spawnerPaused.state) || !matches(cycle.grandchildResumed, before) || !matches(cycle.spawnerResumed, spawner) || !runnable(cycle.grandchildResumed.state) || !runnable(cycle.spawnerResumed.state) || !count(cycle.heartbeatPauseStart) || cycle.heartbeatPauseStart <= 0 || cycle.heartbeatPauseEnd !== cycle.heartbeatPauseStart || !count(cycle.heartbeatResumed) || cycle.heartbeatResumed <= cycle.heartbeatPauseEnd) fail("Darwin observed-before-adoption Ctrl-Z/fg proof missing");
	}
	if (!Array.isArray(row.paused) || row.paused.length !== roles.length || new Set(row.paused.map((v) => v.role)).size !== roles.length) fail("paused inventory missing");
	for (const role of roles) {
		const v = row.paused.find((v) => v.role === role);
		const awake = ["guardian", "observer", "anchor"].includes(role);
		if (!matches(v, p[role]) || (awake ? !runnable(v.state) || role === "anchor" && !/^[RS]/.test(v.state) : !stopped(v.state))) fail(`missing positive paused/runnable ${role} observation`);
	}
	const peer = row.peer;
	if (!pid(peer?.pid) || peer.pid === p.outer.pid || peer.parent !== p.outer.parent || peer.group !== p.outer.group || peer.sid !== p.outer.sid || peer.uid !== identity.uid || typeof peer.birth !== "string" || !peer.birth || !runnable(peer.state)) fail("unowned same-job-group sibling missing");
	if (!matches(row.peerPaused, peer) || !stopped(row.peerPaused.state)) fail("positive paused peer observation missing");
	for (const heartbeat of [row.heartbeats, ...["extensionChild", "adoptedGrandchild"].map((role) => row.descendantHeartbeats?.[role])]) {
		for (const key of ["before", "advancing", "pauseStart", "pauseEnd", "exit", "after", "stableMs"]) if (!count(heartbeat?.[key])) fail("heartbeat observation missing");
		if (heartbeat.advancing <= heartbeat.before || heartbeat.pauseStart <= 0 || heartbeat.pauseEnd !== heartbeat.pauseStart || heartbeat.exit !== heartbeat.after || heartbeat.stableMs < 250) fail("heartbeat not advancing/stable at required boundaries");
	}
	const heartbeat = row.heartbeats;
	if (!count(heartbeat.peerPause) || heartbeat.peerPause <= 0 || !count(heartbeat.peerAfter)) fail("peer heartbeat observation missing");
	if (!count(row.postDeathMs) || row.postDeathMs > 8000 || row.guardExpired !== false || row.allOwnedExited !== true) fail("bounded full teardown missing");
	if (!Array.isArray(row.after) || row.after.length !== roles.length || new Set(row.after.map((v) => v.pid)).size !== roles.length) fail("post-exit inventory missing");
	for (const role of roles) {
		const v = row.after.find((v) => v.pid === p[role].pid);
		if (!v || v.birth !== p[role].birth || !dead(v.state) || (["observer", "anchor", "extensionChild", "adoptedGrandchild"].includes(role) && v.state !== "gone")) fail(`owned ${role} survived/unreaped`);
	}
	if (row.name === "suspend-resume" && (row.resumed !== true || row.exit?.code !== 0 || row.exit?.signal !== null)) fail("normal fg/Ctrl-D exit was not clean");
	const blocked = row.name === "paused-both-owners-death-shutdown-blocked";
	const hook = row.shutdownHook;
	const hookRequired = blocked || ["paused-guardian-death", "paused-both-owners-death"].includes(row.name);
	if (typeof hook?.entered !== "boolean" || hook.enteredBeforeFault !== false || (hook.entered ? hook.pid !== p.pi.pid : hook.pid !== null) || hookRequired && !hook.entered) fail("shutdown-hook entry proof missing");
	const block = row.shutdownBlock;
	if (block?.armed !== blocked || block.entered !== blocked || block.returned !== false || block.enteredBeforeFault !== false || (blocked ? block.pid !== p.pi.pid || !count(block.waitMs) || block.waitMs < 12000 : block.pid !== null || block.waitMs !== null)) fail("shutdown-hook worker deadline proof missing");
	const faults = row.name === "suspend-resume" ? [] : row.name === "paused-outer-death" ? ["outer"] : row.name === "paused-anchor-death" ? ["anchor"] : row.name === "paused-both-owners-death" || blocked ? ["outer", "guardian"] : row.name === "paused-observer-death" ? ["observer"] : ["guardian"];
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
