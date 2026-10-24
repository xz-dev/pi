// Synthetic proof records only. These validate rejection/aggregation, not product behavior.
import { unixOwnerFaultTargets } from "../smoke-unix-owner-pty.mjs";

export function passedUnixIdentity() {
	return { uid: 1001, euid: 1001, gid: 1001, egid: 1001, groups: [1001], groupNames: ["pi-owner-smoke"], elevated: false, adminGroup: false, rootEquivalentGroup: false, capabilities: { CapPrm: "0000000000000000", CapEff: "0000000000000000", CapAmb: "0000000000000000" } };
}

export function passedUnixOwnerPtyRow(name, os, target, cliSha256, uid = 1001) {
	const processes = Object.fromEntries([
		["carrier", 100, 90, 100, 90], ["outer", 112, 100, 100, 90], ["backup", 113, os === "darwin" ? 101 : 107, 100, 90],
		["guardian", 101, os === "darwin" ? 112 : 107, 101, os === "darwin" ? 101 : 107], ["pi", 102, 101, os === "darwin" ? 102 : 101, os === "darwin" ? 101 : 107],
		["taskOuter", 103, 102, 103, 103], ["taskGuardian", 104, 103, 104, 103], ["payload", 105, 104, 103, 103], ["leaf", 106, 105, 103, 103],
		[os === "darwin" ? "observer" : "anchor", 107, 112, 107, 107],
		["extensionChild", 109, 102, os === "darwin" ? 102 : 101, os === "darwin" ? 101 : 107], ["adoptedGrandchild", 110, os === "darwin" ? 1 : 101, 110, 110],
	].map(([role, pid, parent, group, sid]) => [role, { pid, parent, group, sid, uid, birth: `birth:${pid}`, state: "S" }]));
	const blocked = name.endsWith("-shutdown-blocked");
	const faults = unixOwnerFaultTargets(name);
	const terminal = { rows: 40, columns: 120, lflag: 32779, iflag: 0, oflag: 0, cflag: 0, isig: true, icanon: true, echo: true };
	const spawner = { pid: 111, parent: 102, group: processes.pi.group, sid: processes.pi.sid, uid, birth: "birth:111", state: "S" };
	const grandchildBefore = { ...processes.adoptedGrandchild, parent: spawner.pid };
	const heartbeat = { before: 2, advancing: 8, pauseStart: 9, pauseEnd: 9, exit: 10, after: 10, stableMs: 250 };
	return {
		name, status: "passed", target, cliSha256, identity: { uid, euid: uid },
		pi: { pid: 102, parent: 101, uid, bun: "1.3.14", owner: "/fixture/pi-env" },
		aliveBefore: true, aliveAfter: false, peerAlive: true, immediateChecks: 1, guardExpired: false,
		piStopped: true, stopped: true, resumed: name === "suspend-resume", peerRunning: true,
		pty: { physicalDevice: "34817", physicalTty: "/dev/pts/1", harness: "native-openpty", interactive: true, input: "ctrl-z", rawObserved: true, jobForeground: true, noRescueCont: true, shellForeground: true, shellAlive: true, original: terminal, paused: { ...terminal }, raw: { ...terminal, isig: false, icanon: false, echo: false }, after: { ...terminal } },
		processes, paused: Object.entries(processes).map(([role, p]) => ({ ...p, role, state: ["outer", "backup", "guardian", "observer", "anchor"].includes(role) ? "S" : "T" })),
		sessionChildren: os === "darwin" ? { carrier: [112], outer: [101, 107], guardian: [102, 113] } : { carrier: [112], outer: [107], anchor: [101, 113] },
		controllers: Object.fromEntries(["carrier", "outer", "backup", "guardian", os === "darwin" ? "observer" : "anchor", "pi"].map((role) => [role, { ...processes[role], uids: Array(os === "linux" ? 4 : 3).fill(uid), native: role !== "pi", image: role === "pi" ? "/fixture/pi" : "/fixture/pi-env", fds: { schema: 1, source: ({ linux: "procfs", darwin: "lsof-F0", freebsd: "procstat-f" })[os], pid: processes[role].pid, birth: processes[role].birth, image: role === "pi" ? "/fixture/pi" : "/fixture/pi-env", complete: true, records: [0, 1, 2].map((fd) => ({ fd, kind: "char", target: "/dev/pts/2", rdev: "34818" })).concat(os === "freebsd" ? [{ fd: 9, kind: "pty-master", target: "/dev/pts/2", rdev: "34818" }] : []) }, physicalTty: "/dev/pts/1" }])),
		backupReaped: true,
		adoption: { spawner, grandchildBefore, spawnerReaped: true, spawnerState: "gone", spawnerExit: { pid: 111, birth: spawner.birth, code: 0, signal: null }, postExitParent: processes.adoptedGrandchild.parent, observationCycle: os !== "darwin" ? null : { input: "ctrl-z,fg", grandchildPaused: { ...grandchildBefore, state: "T" }, spawnerPaused: { ...spawner, state: "T" }, grandchildResumed: { ...grandchildBefore }, spawnerResumed: { ...spawner }, heartbeatPauseStart: 3, heartbeatPauseEnd: 3, heartbeatResumed: 4, stableMs: 250 } },
		peer: { pid: 108, parent: 90, group: 100, sid: 90, uid, state: "S", birth: "birth:108" }, peerPaused: { pid: 108, parent: 90, group: 100, sid: 90, uid, state: "T", birth: "birth:108" }, peerStoppedAfter: faults.length > 0,
		heartbeats: { ...heartbeat, peerPause: 10, peerAfter: faults.length ? 10 : 12 },
		descendantHeartbeats: { extensionChild: { ...heartbeat }, adoptedGrandchild: { ...heartbeat } },
		shutdownHook: { entered: true, enteredBeforeFault: false, pid: 102 },
		shutdownBlock: { armed: blocked, entered: blocked, returned: false, enteredBeforeFault: false, pid: blocked ? 102 : null, waitMs: blocked ? 12000 : null },
		...(name === "suspend-resume" ? { resizeCycles: [[43, 127], [37, 113]].map(([rows, columns], index) => ({ input: "ctrl-z,bg,fg", physical: { rows, columns }, private: { rows, columns, width: columns, version: String(index + 1) }, frame: `CI_PTY_TOP_${index + 1}\r\nCI_PTY_LAYOUT_${columns}x${rows}\r\n${"~".repeat(columns)}\r\nCI_PTY_BOTTOM_${index + 1}`, bgPrimaryRunnable: true, physicalUiPaused: true, bgCooked: true, fgRaw: true, inputCount: index + 1, listeners: { cont: 1, input: 2, resize: 1 }, initialListeners: { cont: 1, input: 2, resize: 1 } })) } : {}),
		postDeathMs: 100, allOwnedExited: true, exit: faults.includes("carrier") ? { code: null, signal: 9 } : { code: 0, signal: null },
		after: Object.values(processes).map((p) => ({ pid: p.pid, birth: p.birth, state: "gone" })),
		faultTargets: faults.map((role) => ({ role, pid: processes[role].pid, parent: processes[role].parent, birth: processes[role].birth, delivered: true, signal: "SIGKILL", result: 0, method: os === "linux" ? "pidfd" : "checked-birth" })),
		...(os === "darwin" ? { observerReaped: true, observerNative: true } : { anchorReaped: true, anchorNative: true }),
	};
}
