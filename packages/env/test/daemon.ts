import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The daemon the tests run: `PI_ENV_DAEMON` (CI points it at release builds), else the one `cargo build` built in
 * ../daemon.
 */
export const daemon =
	process.env.PI_ENV_DAEMON ??
	resolve(import.meta.dirname, `../daemon/target/debug/pi-env${process.platform === "win32" ? ".exe" : ""}`);
if (!existsSync(daemon)) {
	throw new Error(`Build the daemon first: npm run build:daemon in packages/env (missing ${daemon})`);
}

// Release tests use the selected build target, not the Node client's architecture (e.g. Rosetta).
const targets: Record<string, { platform: string; arch: string }> = {
	"linux-x64": { platform: "linux", arch: "x64" },
	"linux-arm64": { platform: "linux", arch: "arm64" },
	"darwin-x64": { platform: "darwin", arch: "x64" },
	"darwin-arm64": { platform: "darwin", arch: "arm64" },
	"windows-x64": { platform: "win32", arch: "x64" },
	"windows-arm64": { platform: "win32", arch: "arm64" },
};
const target = process.env.PI_ENV_DAEMON_TARGET;
if (process.env.PI_ENV_DAEMON && target === undefined) {
	throw new Error("PI_ENV_DAEMON requires independently selected PI_ENV_DAEMON_TARGET metadata");
}
export const expectedDaemonPlatform =
	target === undefined ? { platform: process.platform, arch: process.arch } : targets[target];
if (!expectedDaemonPlatform) throw new Error(`Unknown PI_ENV_DAEMON_TARGET: ${target}`);
