import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { constants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const unixOwnerFaultRows = (os) => ["paused-outer-death", ...(os !== "darwin" ? ["paused-anchor-death"] : []), "paused-guardian-death", "paused-both-owners-death", "paused-both-owners-death-shutdown-blocked", ...(os === "darwin" ? ["paused-observer-death"] : []), "paused-carrier-death", "paused-backup-death", "paused-carrier-guardian-death", "paused-carrier-outer-death", "paused-carrier-backup-death", "paused-outer-backup-death", "paused-carrier-guardian-death-shutdown-blocked", "paused-carrier-outer-death-shutdown-blocked"];

// outer keeps its original native physical-guardian meaning; carrier is the physical job leader.
export function unixOwnerFaultTargets(name) {
	const base = name.replace(/-shutdown-blocked$/, "");
	const targets = { "suspend-resume": [], "paused-outer-death": ["outer"], "paused-anchor-death": ["anchor"], "paused-guardian-death": ["guardian"], "paused-both-owners-death": ["outer", "guardian"], "paused-observer-death": ["observer"], "paused-carrier-death": ["carrier"], "paused-backup-death": ["backup"], "paused-carrier-guardian-death": ["carrier", "guardian"], "paused-carrier-outer-death": ["carrier", "outer"], "paused-carrier-backup-death": ["carrier", "backup"], "paused-outer-backup-death": ["outer", "backup"] };
	if (!Object.hasOwn(targets, base)) throw new Error(`unknown owner PTY row: ${name}`);
	return targets[base];
}
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
	for (const stage of ["original", "raw", "paused", "after"]) {
		for (const flag of ["lflag", "iflag", "oflag", "cflag"]) if (!count(tty[stage]?.[flag])) fail("terminal state incomplete");
		for (const key of ["rows", "columns"]) if (!count(tty[stage]?.[key]) || tty[stage][key] <= 0) fail("terminal dimensions missing");
	}
	if (tty.raw.icanon !== false || tty.raw.echo !== false) fail("raw terminal snapshot missing");
	const faults = unixOwnerFaultTargets(row.name);
	const roles = ["carrier", "backup", "outer", "guardian", "pi", "taskOuter", "taskGuardian", "payload", "leaf", "extensionChild", "adoptedGrandchild", os === "darwin" ? "observer" : "anchor"];
	if (JSON.stringify(Object.keys(row.processes ?? {}).sort()) !== JSON.stringify([...roles].sort())) fail("owned role inventory missing");
	const p = row.processes;
	for (const role of roles) {
		const v = p[role];
		const validParent = pid(v.parent) || os === "darwin" && role === "adoptedGrandchild" && v.parent === 1;
		if (!pid(v.pid) || !validParent || !pid(v.group) || !pid(v.sid) || v.uid !== identity.uid || typeof v.birth !== "string" || !v.birth || !runnable(v.state)) fail(`invalid pre-pause ${role} identity`);
	}
	if (new Set(roles.map((role) => p[role].pid)).size !== roles.length) fail("duplicate role PID");
	if (row.pi.pid !== p.pi.pid || row.pi.parent !== p.guardian.pid || p.pi.parent !== p.guardian.pid || p.guardian.parent !== (os === "darwin" ? p.outer.pid : p.anchor.pid) || p.outer.parent !== p.carrier.pid || p.backup.parent !== (os === "darwin" ? p.guardian.pid : p.anchor.pid) || p.taskOuter.parent !== p.pi.pid || p.taskGuardian.parent !== p.taskOuter.pid || p.payload.parent !== p.taskGuardian.pid || p.leaf.parent !== p.payload.pid || p.extensionChild.parent !== p.pi.pid) fail("wrong owner/task/extension ancestry");
	if (p.carrier.group !== p.carrier.pid || [p.outer, p.backup].some((v) => v.group !== p.carrier.group || v.sid !== p.carrier.sid) || p.pi.sid === p.carrier.sid || p.guardian.sid !== p.pi.sid || p.guardian.group !== p.guardian.pid || p.pi.group !== (os === "darwin" ? p.pi.pid : p.guardian.group) || p.taskOuter.group === p.pi.group || p.extensionChild.sid !== p.pi.sid) fail("wrong foreground/task groups/session");
	if (JSON.stringify(row.sessionChildren?.carrier) !== JSON.stringify([p.outer.pid])) fail("carrier direct-child inventory wrong");
	const sessionChild = os === "darwin" ? [p.guardian.pid, p.observer.pid].sort((a, b) => a - b) : [p.anchor.pid];
	if (JSON.stringify(row.sessionChildren?.outer) !== JSON.stringify(sessionChild)) fail("outer direct-child inventory wrong");
	if (os !== "darwin" && (p.anchor.parent !== p.outer.pid || p.anchor.group !== p.anchor.pid || p.anchor.group === p.outer.group || p.anchor.sid !== p.anchor.pid || p.guardian.sid !== p.anchor.sid || !/^[RS]/.test(p.anchor.state) || row.anchorReaped !== true || row.anchorNative !== true || JSON.stringify(row.sessionChildren?.anchor) !== JSON.stringify([p.guardian.pid, p.backup.pid, ...(p.adoptedGrandchild.parent === p.anchor.pid ? [p.adoptedGrandchild.pid] : [])].sort((a, b) => a - b)))) fail("runnable/outside-group native anchor/reaping proof missing");
	if (os === "darwin" && (p.observer.parent !== p.outer.pid || p.observer.group === p.outer.group || p.observer.group === p.taskOuter.group || p.observer.sid !== p.observer.pid || p.observer.group !== p.observer.pid || p.guardian.sid !== p.guardian.pid || p.guardian.group === p.pi.group || JSON.stringify(row.sessionChildren?.guardian) !== JSON.stringify([p.pi.pid, p.backup.pid].sort((a, b) => a - b)) || row.observerReaped !== true || row.observerNative !== true)) fail("runnable/outside-group native observer/reaping proof missing");
	const controllerRoles = ["carrier", "outer", "backup", "guardian", os === "darwin" ? "observer" : "anchor", "pi"];
	if (JSON.stringify(Object.keys(row.controllers ?? {}).sort()) !== JSON.stringify([...controllerRoles].sort())) fail("controller role inventory wrong");
	for (const role of controllerRoles) {
		const v = row.controllers?.[role];
		if (!v || !matches(v, p[role]) || !Array.isArray(v.uids) || v.uids.length !== (os === "linux" ? 4 : 3) || v.uids.some((uid) => uid !== identity.uid) || typeof v.image !== "string" || !v.image || v.native !== (role !== "pi") || role !== "pi" && v.image !== row.pi.owner || v.physicalTty !== tty.physicalTty) fail(`native image/FD/current identity missing: ${role}`);
		const fds = v.fds;
		if (fds?.schema !== 1 || fds.source !== ({ linux: "procfs", darwin: "lsof-F0", freebsd: "procstat-f" })[os] || fds.pid !== v.pid || fds.birth !== v.birth || fds.image !== v.image || fds.complete !== true || !Array.isArray(fds.records)) fail(`native FD provenance missing: ${role}`);
		const seen = new Set();
		for (const fd of fds.records) {
			if (!count(fd?.fd) || fd.fd > 2147483647 || seen.has(fd.fd) || !["char", "pty-master", "file", "directory", "block", "pipe", "socket", "event"].includes(fd.kind) || typeof fd.target !== "string" || !fd.target || fd.target === "unavailable" || /[\r\n]/.test(fd.target) || fd.target === "-" && !["pipe", "socket", "event"].includes(fd.kind)) fail(`malformed native FD record: ${role}`);
			seen.add(fd.fd);
			if (os === "linux" && (fd.kind === "pipe" ? !/^pipe:\[[0-9]+\]$/.test(fd.target) : fd.kind === "socket" ? !/^socket:\[[0-9]+\]$/.test(fd.target) : fd.kind === "event" ? !/^anon_inode:\[[a-z0-9_]+\]$/.test(fd.target) : !fd.target.startsWith("/"))) fail(`native FD kind/target mismatch: ${role}`);
			if (fd.kind === "pty-master" && (os !== "freebsd" || !/^\/dev\/pts\/[0-9]+$/.test(fd.target))) fail(`native PTY master provenance missing: ${role}`);
			if (["char", "pty-master"].includes(fd.kind) ? !fd.target.startsWith("/dev/") || typeof fd.rdev !== "string" || !/^(0|[1-9][0-9]*)$/.test(fd.rdev) || BigInt(fd.rdev) > 18446744073709551615n : fd.rdev !== null) fail(`native FD device missing: ${role}`);
			if (["pi", "guardian", "anchor", "observer"].includes(role) && ["char", "pty-master"].includes(fd.kind) && (fd.rdev === tty.physicalDevice || ["/dev/tty", "/dev/console", "/dev/stdin", "/dev/stdout", "/dev/stderr"].includes(fd.target) || fd.target.startsWith("/dev/fd/"))) fail(`private role retains physical TTY/ambiguous alias: ${role}`);
		}
		if (![0, 1, 2].every((fd) => seen.has(fd))) fail(`native FD coverage incomplete: ${role}`);
	}
	if (typeof tty.physicalDevice !== "string" || !/^[1-9][0-9]*$/.test(tty.physicalDevice) || BigInt(tty.physicalDevice) > 18446744073709551615n) fail("physical tty native device missing");
	if (typeof tty.physicalTty !== "string" || !tty.physicalTty.startsWith("/dev/") || row.backupReaped !== true) fail("physical tty/backup reap proof missing");
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
		const awake = ["outer", "backup", "guardian", "observer", "anchor"].includes(role);
		if (!matches(v, p[role]) || (awake ? !runnable(v.state) || role === "anchor" && !/^[RS]/.test(v.state) : !stopped(v.state))) fail(`missing positive paused/runnable ${role} observation`);
	}
	const peer = row.peer;
	if (!pid(peer?.pid) || peer.pid === p.carrier.pid || peer.parent !== p.carrier.parent || peer.group !== p.carrier.group || peer.sid !== p.carrier.sid || peer.uid !== identity.uid || typeof peer.birth !== "string" || !peer.birth || !runnable(peer.state)) fail("unowned same-job-group sibling missing");
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
		if (!v || v.birth !== p[role].birth || !dead(v.state) || (["carrier", "outer", "backup", "guardian", "pi", "observer", "anchor", "extensionChild", "adoptedGrandchild"].includes(role) && v.state !== "gone")) fail(`owned ${role} survived/unreaped`);
	}
	if (row.name === "suspend-resume" && (row.resumed !== true || row.exit?.code !== 0 || row.exit?.signal !== null)) fail("normal fg/Ctrl-D exit was not clean");
	if (row.name === "suspend-resume") {
		if (!Array.isArray(row.resizeCycles) || row.resizeCycles.length !== 2) fail("two real background resize/fg cycles missing");
		for (const [index, cycle] of row.resizeCycles.entries()) {
			const [rows, columns] = [[43, 127], [37, 113]][index];
			const version = String(index + 1);
			if (cycle.input !== "ctrl-z,bg,fg" || cycle.bgPrimaryRunnable !== true || cycle.physicalUiPaused !== true || cycle.bgCooked !== true || cycle.fgRaw !== true || cycle.inputCount !== index + 1) fail("resize cycle bg/fg/input proof missing");
			if (cycle.physical?.rows !== rows || cycle.physical?.columns !== columns || cycle.private?.rows !== rows || cycle.private?.columns !== columns || cycle.private?.width !== columns || cycle.private?.version !== version) fail("private/current physical dimensions stale");
			for (const key of ["cont", "input", "resize"]) if (!count(cycle.listeners?.[key]) || cycle.listeners[key] !== cycle.initialListeners?.[key]) fail("UI listeners grew/missing");
			const frame = cycle.frame;
			const top = `CI_PTY_TOP_${version}`, layout = `CI_PTY_LAYOUT_${columns}x${rows}`, bottom = `CI_PTY_BOTTOM_${version}`;
			if (typeof frame !== "string" || !frame.startsWith(top)) fail("actual current full frame missing");
			const layoutAt = frame.indexOf(layout), barAt = frame.indexOf("~", layoutAt);
			const bar = barAt < 0 ? "" : /^~+/.exec(frame.slice(barAt))?.[0];
			if (layoutAt < top.length || barAt < layoutAt + layout.length || bar?.length !== columns || frame.indexOf(bottom, barAt + columns) < 0) fail("actual width-dependent current full layout missing");
		}
	}

	const blocked = row.name.endsWith("-shutdown-blocked");
	const hook = row.shutdownHook;
	const hookRequired = blocked || faults.length > 0 && !["paused-outer-death", "paused-anchor-death", "paused-observer-death"].includes(row.name);
	if (typeof hook?.entered !== "boolean" || hook.enteredBeforeFault !== false || (hook.entered ? hook.pid !== p.pi.pid : hook.pid !== null) || hookRequired && !hook.entered) fail("shutdown-hook entry proof missing");
	const block = row.shutdownBlock;
	if (block?.armed !== blocked || block.entered !== blocked || block.returned !== false || block.enteredBeforeFault !== false || (blocked ? block.pid !== p.pi.pid || !count(block.waitMs) || block.waitMs < 12000 : block.pid !== null || block.waitMs !== null)) fail("shutdown-hook worker deadline proof missing");
	if (JSON.stringify(row.faultTargets?.map((v) => v.role)) !== JSON.stringify(faults)) fail("fault inventory wrong");
	for (const v of row.faultTargets) if (["pid", "birth", "parent"].some((key) => v[key] !== p[v.role]?.[key]) || v.delivered !== true || v.signal !== "SIGKILL" || v.result !== 0 || v.method !== (os === "linux" ? "pidfd" : "checked-birth")) fail("fault target birth/ancestry/pidfd proof missing");
	if (faults.includes("carrier") && (row.exit?.code !== null || row.exit?.signal !== 9)) fail("carrier actual SIGKILL terminal status missing");
	if (faults.length && (row.peerStoppedAfter !== true || heartbeat.peerAfter !== heartbeat.peerPause)) fail("unowned peer resumed by product");
}

// Diagnostics never use wrapper/native epoch equivalence or supply acceptance evidence.
function readUnixOwnerHelperWitness(work, name) {
	const unknown = { outcome: "unknown", repair: null };
	if (!["suspend-resume", ...unixOwnerFaultRows("linux"), ...unixOwnerFaultRows("darwin")].includes(name)) return unknown;
	let fd;
	try {
		const path = resolve(work, "helper-witness");
		const directory = lstatSync(work, { bigint: true });
		if (!directory.isDirectory() || directory.uid !== BigInt(process.getuid()) || (directory.mode & 0o022n) !== 0n) return unknown;
		fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
		const before = fstatSync(fd, { bigint: true });
		const equal = (a, b) => ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeNs", "ctimeNs"].every((key) => typeof a[key] === "bigint" && a[key] === b[key]);
		if (!before.isFile() || before.uid !== BigInt(process.getuid()) || (before.mode & 0o7777n) !== 0o600n || before.nlink !== 1n || before.size <= 0n || before.size > 16384n || !equal(before, lstatSync(path, { bigint: true }))) return unknown;
		const buffer = Buffer.alloc(16384);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		const after = fstatSync(fd, { bigint: true });
		const afterDirectory = lstatSync(work, { bigint: true });
		if (BigInt(length) !== before.size || !equal(before, after) || !equal(before, lstatSync(path, { bigint: true })) || !afterDirectory.isDirectory() || !["dev", "ino", "mode", "uid"].every((key) => typeof directory[key] === "bigint" && directory[key] === afterDirectory[key])) return unknown;
		const descriptor = fd; fd = undefined; closeSync(descriptor);
		const text = buffer.subarray(0, length).toString("ascii");
		if (!buffer.subarray(0, length).equals(Buffer.from(text, "ascii")) || !text.endsWith("\n")) return unknown;
		const lines = text.slice(0, -1).split("\n");
		if (lines.shift() !== `owner-helper-v1 ${name}`) return unknown;
		const cleanupAt = lines.findIndex((line) => line.startsWith("cleanup-session-v1 "));
		const cleanup = cleanupAt < 0 ? [] : lines.splice(cleanupAt);
		if (lines.length < 2 || lines.length > 8 || lines.length % 2 !== 0) return unknown;
		const operations = ["grandchild-spawn", "snapshot", "pin", "publish"];
		let previous = 0n, failed;
		for (const [index, line] of lines.entries()) {
			const match = /^adoption-spawner (grandchild-spawn|snapshot|pin|publish) (begin|completed|error) ([1-8]) (0|[1-9][0-9]{0,19}) (none|native-error|operation-error) (-|ENOENT|EACCES|EPERM|EAGAIN|ENOMEM|ENOEXEC|EMFILE|ENFILE|EINVAL|EIO|other)$/.exec(line);
			if (!match) return unknown;
			const [, operation, stage, sequence, elapsed, category, errno] = match;
			const time = BigInt(elapsed);
			if (Number(sequence) !== index + 1 || operation !== operations[Math.floor(index / 2)] || time < previous || time > 18446744073709551615n || (index % 2 === 0 ? stage !== "begin" : !["completed", "error"].includes(stage))) return unknown;
			if (stage === "error") {
				if (index !== lines.length - 1 || category === "none" || (category === "native-error" ? errno === "-" : errno !== "-")) return unknown;
				failed = operation;
			} else if (category !== "none" || errno !== "-") return unknown;
			previous = time;
		}
		if (failed) return cleanup.length ? unknown : { outcome: "operation-error", operation: failed, repair: { "grandchild-spawn": "ci-child-launch-setup", snapshot: "ci-native-query-error", pin: "ci-identity-sampling", publish: "ci-file-publication" }[failed], clock: "native-process-local" };
		return lines.length === 8 ? readCleanupSession(cleanup) : unknown;
	} catch { return unknown; }
	finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* Diagnostic I/O must not replace original failure. */ } } }
}

// Session-local cleanup time follows only a complete successful helper prefix.
// Exactly one completed operation crossing the original budget selects its CI seam.
function readCleanupSession(lines) {
	const unknown = { outcome: "unknown", repair: null };
	const number = (value) => /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n ? BigInt(value) : null;
	if (lines.length < 2 || lines.length > 6 || lines[0] !== "cleanup-session-v1 begin 0") return unknown;
	const terminal = /^cleanup-session-v1 timeout ([0-9]+)$/.exec(lines.at(-1));
	const end = terminal && number(terminal[1]);
	const budget = 8_000_000_000n;
	if (end === null || end < budget) return unknown;
	const intervals = [];
	let previous = 0n, phase = "fault", faults = 0, inventory = null;
	for (const line of lines.slice(1, -1)) {
		const match = /^cleanup-session-v1 (fault|inventory) ([1-9][0-9]{0,19}) ([0-9]+) ([0-9]+) ok$/.exec(line);
		if (!match) return unknown;
		const [, kind, ordinalText, beginText, endText] = match;
		const ordinal = number(ordinalText), begin = number(beginText), finish = number(endText);
		if (ordinal === null || begin === null || finish === null || begin < previous || finish < begin || finish > end) return unknown;
		if (kind === "fault") {
			if (phase !== "fault" || ordinal !== BigInt(++faults) || faults > 2) return unknown;
		} else {
			phase = "inventory";
			if ((inventory !== null && ordinal !== inventory + 1n) || intervals.filter((v) => v.kind === kind).length >= 2) return unknown;
			inventory = ordinal;
		}
		intervals.push({ kind, begin, finish });
		previous = finish;
	}
	const crossing = intervals.filter((v) => v.begin < budget && v.finish >= budget);
	if (crossing.length !== 1 || crossing[0] !== intervals.at(-1)) return unknown;
	return crossing[0].kind === "fault"
		? { outcome: "cleanup-cost", operation: "held-fault-delivery", repair: "ci-held-fault-delivery", clock: "native-session-local" }
		: { outcome: "cleanup-cost", operation: "complete-inventory", repair: "ci-owned-observation", clock: "native-session-local" };
}

export function smokeUnixOwnerPty(executable, target, name, work, identity, { harness = process.env.PI_OWNER_PTY_HARNESS } = {}) {
	if (!harness) return { name, status: "failed", error: "PI_OWNER_PTY_HARNESS must name the architecture-matched CI-only fixture" };
	mkdirSync(work, { recursive: true });
	const timeoutMs = target.emulated ? 180_000 : 60_000;
	const result = spawnSync(resolve(harness), ["--run", executable, fileURLToPath(new URL("./fixtures/owner/", import.meta.url)), work, name, String(timeoutMs)], { encoding: "utf8", timeout: timeoutMs + 20_000, maxBuffer: 1024 * 1024 });
	let row;
	let category = "parse";
	try { row = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); category = "invocation"; }
	catch { row = { name, status: "failed", error: `PTY fixture missing evidence (${result.status ?? result.error?.message}): ${result.stderr?.slice(-4096)}` }; }
	Object.assign(row, { target: target.id, cliSha256: hash(executable) });
	try {
		if (result.status !== 0 || row.status !== "passed" || row.name !== name) throw new Error(row.error || `PTY fixture failed (${result.status ?? result.error?.message})`);
		category = "validation";
		assertUnixOwnerPtyRow(row, target.os, identity, target.id, hash(executable));
	} catch (error) {
		row.status = "failed"; row.error = error.message;
		// Setup failure cannot attribute any stale, valid-looking pre-existing witness.
		const helperWitness = result.stderr?.includes("[owner-pty] helper-witness-init-failed") ? { outcome: "unknown", repair: null } : readUnixOwnerHelperWitness(work, name);
		// Returned scalars only; diagnostic output never supplies acceptance evidence.
		process.stderr.write(`[owner-pty] ${JSON.stringify({ phase: "fixture-return", row: ["suspend-resume", ...unixOwnerFaultRows(target.os)].includes(name) ? name : "unknown", category, status: Number.isInteger(result.status) && result.status >= 0 && result.status <= 255 ? result.status : null, signal: typeof result.signal === "string" && Object.hasOwn(constants.signals, result.signal) ? result.signal : null, errorCode: typeof result.error?.code === "string" && Object.hasOwn(constants.errno, result.error.code) ? result.error.code : null, helperWitness })}\n`);
	}
	return row;
}
