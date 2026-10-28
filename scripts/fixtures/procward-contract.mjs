// Synthetic validator input only; never platform/runtime acceptance evidence.
import { bunTarget } from "../lib/bun-targets.mjs";
import { PROCWARD_PIN } from "../lib/procward-pin.mjs";
import { PROCWARD_CONTRACT_CASES } from "../smoke-procward-contract.mjs";

export function passedProcwardContract(targetId, piSha256) {
	const target = bunTarget(targetId).cargoTarget;
	const pin = PROCWARD_PIN;
	const hook = { noticeOnly: true, parentAlive: true, hookRan: true, terminalRestored: true, terminalBefore: [1, 2], terminalAfter: [1, 2], elapsedMs: 1, blockedHook: false };
	return {
		schemaVersion: 1, status: "passed", target: targetId, piSha256,
		procward: { state: pin.state, version: pin.version, repository: pin.repository, workflow: pin.workflow, sourceCommit: pin.sourceCommit, tag: pin.tag, target, ...pin.targets[target] },
		cases: PROCWARD_CONTRACT_CASES.map((name) => ({ name, passed: true })),
		notice: hook,
		blocked: { ...hook, elapsedMs: 5000, blockedHook: true },
	};
}
