// Synthetic proof records only. These validate rejection/aggregation, not product behavior.
export function passedUnixIdentity() {
	return { uid: 1001, euid: 1001, gid: 1001, egid: 1001, groups: [1001], groupNames: ["pi-owner-smoke"], elevated: false, adminGroup: false, rootEquivalentGroup: false, capabilities: { CapPrm: "0000000000000000", CapEff: "0000000000000000", CapAmb: "0000000000000000" } };
}

export function passedUnixOwnerPtyRow(name, os, target, cliSha256) {
	const processes = Object.fromEntries([
		["outer", 100, 90, 100], ["guardian", 101, 100, 101], ["pi", 102, 101, 100],
		["taskOuter", 103, 102, 103], ["taskGuardian", 104, 103, 104], ["payload", 105, 104, 103], ["leaf", 106, 105, 103],
		...(os === "darwin" ? [["observer", 107, 100, 107]] : []),
	].map(([role, pid, parent, group]) => [role, { pid, parent, group, uid: 1001, birth: `birth:${pid}`, state: "S" }]));
	const faults = name === "suspend-resume" ? [] : name === "paused-both-owners-death" ? ["outer", "guardian"] : name === "paused-observer-death" ? ["observer"] : ["guardian"];
	const terminal = { lflag: 32779, iflag: 0, oflag: 0, cflag: 0, isig: true, icanon: true, echo: true };
	return {
		name, status: "passed", target, cliSha256, identity: { uid: 1001, euid: 1001 },
		pi: { pid: 102, parent: 101, uid: 1001, bun: "1.3.14", owner: "/fixture/pi-env" },
		aliveBefore: true, aliveAfter: false, peerAlive: true, immediateChecks: 1, guardExpired: false,
		piStopped: true, stopped: true, resumed: name === "suspend-resume", peerRunning: true,
		pty: { harness: "native-openpty", interactive: true, input: "ctrl-z", rawObserved: true, noRescueCont: true, shellForeground: true, shellAlive: true, original: terminal, after: { ...terminal } },
		processes, paused: Object.entries(processes).map(([role, p]) => ({ ...p, role, state: ["guardian", "observer"].includes(role) ? "S" : "T" })),
		peer: { pid: 108, parent: 90, group: 100, uid: 1001, state: "S", birth: "birth:108" }, peerStoppedAfter: faults.length > 0,
		heartbeats: { before: 2, advancing: 8, pauseStart: 9, pauseEnd: 9, exit: 10, after: 10, peerPause: 10, peerAfter: faults.length ? 10 : 12, stableMs: 250 },
		postDeathMs: 100, allOwnedExited: true,
		after: Object.values(processes).map((p) => ({ pid: p.pid, birth: p.birth, state: "gone" })),
		faultTargets: faults.map((role) => ({ role, pid: processes[role].pid, parent: processes[role].parent, birth: processes[role].birth, method: os === "linux" ? "pidfd" : "checked-birth" })),
		...(os === "darwin" ? { observerReaped: true, observerNative: true } : {}),
	};
}
