import { readFileSync } from "node:fs";
import { WINDOWS_OWNER_TEST_NAMES, windowsOwnerGateDependencies } from "../smoke-windows-owner-gate.mjs";

export function passedWindowsOwnerGate(target, cliSha256, identity = { name: "host\\pi-owner-smoke" }) {
	return {
		status: "passed", target, elapsedMs: 1,
		dependencies: windowsOwnerGateDependencies(JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"))),
		runtimes: ["node", "bun"].map((name) => ({
			name, status: "passed", version: name === "node" ? "22.22.2" : "1.3.14", exitCode: 0,
			...(name === "bun" ? { artifactBunVersion: "1.3.14", runnerBunVersion: "1.3.14", match: true, runnerBunPath: "C:/scratch/bun.exe", runnerBunSha256: "a".repeat(64), command: ["C:/scratch/bun.exe", "test"] } : {}),
			counts: { passed: WINDOWS_OWNER_TEST_NAMES.length, failed: 0, skipped: 0, todo: 0 },
			tests: WINDOWS_OWNER_TEST_NAMES.map((name) => ({ name, status: "passed" })),
			artifact: { artifact: target, platform: "win32", runtime: { node: "22.22.2", bun: "1.3.14" }, ownerSha256: "e".repeat(64), cliSha256 },
			identity: { name: identity.name, whoamiAll: "S-1-16-8192", elevated: false, admin: false, inheritedJob: true },
		})),
	};
}
