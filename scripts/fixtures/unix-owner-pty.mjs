// Synthetic proof records only. These validate rejection/aggregation, not product behavior.
export function passedUnixIdentity() {
	return { uid: 1001, euid: 1001, gid: 1001, egid: 1001, groups: [1001], groupNames: ["pi-owner-smoke"], elevated: false, adminGroup: false, rootEquivalentGroup: false, capabilities: { CapPrm: "0000000000000000", CapEff: "0000000000000000", CapAmb: "0000000000000000" } };
}

export function passedUnixOwnerPtyRow(name, os, target, cliSha256, uid = 1001) {
	const processes = Object.fromEntries([
		["outer", 100, 90, 100, 90], ["guardian", 101, os === "darwin" ? 100 : 107, 101, 90], ["pi", 102, 101, 100, 90],
		["taskOuter", 103, 102, 103, 103], ["taskGuardian", 104, 103, 104, 103], ["payload", 105, 104, 103, 103], ["leaf", 106, 105, 103, 103],
		[os === "darwin" ? "observer" : "anchor", 107, 100, 107, 90],
		["extensionChild", 109, 102, 100, 90], ["adoptedGrandchild", 110, os === "darwin" ? 1 : 101, 110, 110],
	].map(([role, pid, parent, group, sid]) => [role, { pid, parent, group, sid, uid, birth: `birth:${pid}`, state: "S" }]));
	const blocked = name === "paused-both-owners-death-shutdown-blocked";
	const faults = name === "suspend-resume" ? [] : name === "paused-outer-death" ? ["outer"] : name === "paused-anchor-death" ? ["anchor"] : name === "paused-both-owners-death" || blocked ? ["outer", "guardian"] : name === "paused-observer-death" ? ["observer"] : ["guardian"];
	const terminal = { lflag: 32779, iflag: 0, oflag: 0, cflag: 0, isig: true, icanon: true, echo: true };
	const spawner = { pid: 111, parent: 102, group: 100, sid: 90, uid, birth: "birth:111", state: "S" };
	const grandchildBefore = { ...processes.adoptedGrandchild, parent: spawner.pid };
	const heartbeat = { before: 2, advancing: 8, pauseStart: 9, pauseEnd: 9, exit: 10, after: 10, stableMs: 250 };
	return {
		name, status: "passed", target, cliSha256, identity: { uid, euid: uid },
		pi: { pid: 102, parent: 101, uid, bun: "1.3.14", owner: "/fixture/pi-env" },
		aliveBefore: true, aliveAfter: false, peerAlive: true, immediateChecks: 1, guardExpired: false,
		piStopped: true, stopped: true, resumed: name === "suspend-resume", peerRunning: true,
		pty: { harness: "native-openpty", interactive: true, input: "ctrl-z", rawObserved: true, jobForeground: true, noRescueCont: true, shellForeground: true, shellAlive: true, original: terminal, after: { ...terminal } },
		processes, paused: Object.entries(processes).map(([role, p]) => ({ ...p, role, state: ["guardian", "observer", "anchor"].includes(role) ? "S" : "T" })),
		sessionChildren: os === "darwin" ? { outer: [101, 107] } : { outer: [107], anchor: [101] },
		adoption: { spawner, grandchildBefore, spawnerReaped: true, spawnerState: "gone", spawnerExit: { pid: 111, birth: spawner.birth, code: 0, signal: null }, postExitParent: processes.adoptedGrandchild.parent, observationCycle: os !== "darwin" ? null : { input: "ctrl-z,fg", grandchildPaused: { ...grandchildBefore, state: "T" }, spawnerPaused: { ...spawner, state: "T" }, grandchildResumed: { ...grandchildBefore }, spawnerResumed: { ...spawner }, heartbeatPauseStart: 3, heartbeatPauseEnd: 3, heartbeatResumed: 4, stableMs: 250 } },
		peer: { pid: 108, parent: 90, group: 100, sid: 90, uid, state: "S", birth: "birth:108" }, peerPaused: { pid: 108, parent: 90, group: 100, sid: 90, uid, state: "T", birth: "birth:108" }, peerStoppedAfter: faults.length > 0,
		heartbeats: { ...heartbeat, peerPause: 10, peerAfter: faults.length ? 10 : 12 },
		descendantHeartbeats: { extensionChild: { ...heartbeat }, adoptedGrandchild: { ...heartbeat } },
		shutdownBlock: { armed: blocked, entered: blocked, returned: false, enteredBeforeFault: false, pid: blocked ? 102 : null, waitMs: blocked ? 12000 : null },
		postDeathMs: 100, allOwnedExited: true, exit: { code: 0, signal: null },
		after: Object.values(processes).map((p) => ({ pid: p.pid, birth: p.birth, state: "gone" })),
		faultTargets: faults.map((role) => ({ role, pid: processes[role].pid, parent: processes[role].parent, birth: processes[role].birth, method: os === "linux" ? "pidfd" : "checked-birth" })),
		...(os === "darwin" ? { observerReaped: true, observerNative: true } : { anchorReaped: true, anchorNative: true }),
	};
}
