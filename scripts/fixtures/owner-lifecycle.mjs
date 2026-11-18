// Canonical passing owner-lifecycle rows for aggregator/assertion unit tests.
export const INSTALLED_TASK_PROOF = {
	foreground: [23, 23],
	selfOwnerPid: 20,
	taskIds: [1, 2],
	taskOwnerPids: [21, 22],
	causalAfter1600ms: ["1".repeat(32), "2".repeat(32)],
	cancellation: [
		{ id: 0, status: "not-cancellable" },
		{ id: 1, status: "confirmed", exitCode: 23, scope: "kernel", unconfirmed: false },
	],
	survivorAfterCancellation: "3".repeat(32),
	timeout: { leafPid: 30, cleaned: true },
};

export function passedOwnerRows(os, bun = "1.3.14") {
	const row = (name) => ({
		name,
		pi: { bun },
		status: "passed",
		aliveBefore: true,
		aliveAfter: false,
		peerAlive: true,
		immediateChecks: 1,
	});
	return [
		...["normal-double-fork", "kill-double-fork", "normal-setsid", "kill-setsid"].map(row),
		...(os === "windows"
			? ["normal-installed-task", "kill-installed-task"].map((name) => ({
					...row(name),
					pi: { bun, installed: structuredClone(INSTALLED_TASK_PROOF) },
				}))
			: []),
		...(os === "darwin"
			? [{ ...row("darwin-fast-escape"), status: "known-limitation", limitation: "unseen setsid escape" }]
			: []),
	];
}
