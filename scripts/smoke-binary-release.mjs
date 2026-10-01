#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, tmpdir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import { EMULATED_SMOKE_SLOWDOWN, bunTarget, smokeLimits } from "./lib/bun-targets.mjs";
import { cpuFeatures } from "./lib/cpu-features.mjs";
import { operatingSystemArchitecture } from "./lib/runtime-architecture.mjs";
import { verifyMuslSmokeLibraries } from "./prepare-musl-smoke.mjs";

const [assetArg, targetId, expectedVersion, recordArg] = process.argv.slice(2);
if (!assetArg || !targetId || !expectedVersion || !recordArg) throw new Error("Usage: smoke-binary-release.mjs <pi-<target>[.exe]> <target> <version> <record.json>");
const target = bunTarget(targetId);
const SMOKE_LIMITS = smokeLimits(targetId);
const hangGuardScale = target.emulated ? EMULATED_SMOKE_SLOWDOWN : 1;
const asset = resolve(assetArg);
const recordPath = resolve(recordArg);
const work = mkdtempSync(join(tmpdir(), "pi-binary-smoke-"));
const commands = [];
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function run(name, command, args, options = {}) {
	const started = performance.now();
	// The kill timeout is only a hang guard. Budgets are enforced from the
	// measured elapsed time below, so a slow run reports its real duration
	// instead of dying at the budget with SIGTERM.
	const result = spawnSync(command, args, { encoding: "utf8", timeout: (options.timeout ?? 60_000) * hangGuardScale, env: options.env });
	const elapsedMs = Math.round(performance.now() - started);
	commands.push({ name, command: [command, ...args].join(" "), status: result.status, elapsedMs });
	if (result.status !== 0) throw new Error(`${name} failed after ${elapsedMs}ms (${result.status ?? result.signal ?? result.error?.message ?? "unknown"}): ${result.stdout ?? ""}${result.stderr ?? ""}`);
	if (options.maxMs && elapsedMs > options.maxMs) throw new Error(`${name} ${elapsedMs}ms exceeds ${options.maxMs}ms`);
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", elapsedMs };
}
try {
	const assetBytes = statSync(asset).size;
	if (assetBytes > SMOKE_LIMITS.assetBytes) throw new Error(`executable size ${assetBytes} exceeds ${SMOKE_LIMITS.assetBytes}`);
	// The release artifact is the raw executable. Stage it under the public
	// entrypoint name (`pi`/`pi.exe`) so self-path resolution behaves like an
	// installed copy.
	const install = join(work, "install");
	mkdirSync(install, { recursive: true });
	const executable = join(install, target.os === "windows" ? "pi.exe" : "pi");
	copyFileSync(asset, executable);
	if (target.os !== "windows") chmodSync(executable, 0o755);
	const isolatedTmp = join(work, "tmpdir");
	mkdirSync(isolatedTmp, { recursive: true });
	const env = { ...process.env, NODE_ENV: "production", PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(work, "isolated-agent"), HOME: join(work, "home"), USERPROFILE: join(work, "home"), TMPDIR: isolatedTmp, TEMP: isolatedTmp, TMP: isolatedTmp, TERM: "xterm-256color", PI_XZ_TUI_TIMEOUT_MS: String(SMOKE_LIMITS.interactiveMs) };
	mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
	mkdirSync(join(work, "home"), { recursive: true });
	const tuiEnv = { ...env, PI_XZ_TUI_PASTE_PROBE: "1", ...(target.os === "windows" ? { PI_STARTUP_BENCHMARK: "1" } : {}) };
	const coldVersion = run("cold-version", executable, ["--version"], { env, maxMs: SMOKE_LIMITS.coldVersionMs });
	if (coldVersion.stdout.trim() !== expectedVersion) throw new Error(`cold version mismatch: ${coldVersion.stdout.trim()}`);
	const bytecode = run("bytecode", executable, ["--version"], { env: { ...env, BUN_JSC_verboseDiskCache: "1" }, maxMs: SMOKE_LIMITS.versionMs });
	if (bytecode.stdout.trim() !== expectedVersion) throw new Error(`bytecode version mismatch: ${bytecode.stdout.trim()}`);
	if (!bytecode.stderr.includes("[Disk Cache] Cache hit for sourceCode")) throw new Error("executable did not load its entrypoint from embedded bytecode");
	const version = run("version", executable, ["--version"], { env, maxMs: SMOKE_LIMITS.versionMs });
	if (version.stdout.trim() !== expectedVersion) throw new Error(`version mismatch: ${version.stdout.trim()}`);
	const help = run("help", executable, ["--help"], { env, maxMs: SMOKE_LIMITS.helpMs });
	if (!help.stdout.includes("Usage") && !help.stdout.includes("pi")) throw new Error("help output was not recognized");
	const listModels = run("list-models", executable, ["--list-models"], { env, maxMs: SMOKE_LIMITS.listModelsMs });
	if (!listModels.stdout.trim()) throw new Error("list-models produced no output");
	// Resource materialization: the paste-probed TUI session below unfolds the
	// embedded native helper into the per-user tmpdir cache (Linux needs a
	// display, which CI provides via Xvfb; Windows loads the helper at TUI
	// startup, macOS on the paste). Asserted after the TUI run.
	const helperRelative = `${target.nativeHelperDir}/${target.nativeHelperFile}`;
	const muslLibraries = target.libc === "musl" ? verifyMuslSmokeLibraries(process.env.PI_XZ_MUSL_LIBRARIES, target.arch) : null;
	let tui;
	if (process.env.PI_XZ_TUI_EVIDENCE) {
		tui = JSON.parse(readFileSync(process.env.PI_XZ_TUI_EVIDENCE, "utf8"));
		if (tui.harness !== "Bun.Terminal PTY" || !Number.isSafeInteger(tui.elapsedMs) || tui.elapsedMs < 0 || tui.elapsedMs > SMOKE_LIMITS.interactiveMs || !Number.isSafeInteger(tui.outputBytes) || tui.outputBytes <= 0 || (tui.input !== "ctrl-v,ctrl-c,ctrl-d" && tui.input !== "ctrl-c,ctrl-d") || tui.childExitCode !== 0 || !tui.terminalClosed || !Number.isSafeInteger(tui.terminalExitCode) || !tui.observedOutput || tui.benchmarkCompleted !== null || !tui.exitSent || !tui.cleanExit) throw new Error("invalid external TUI evidence");
		commands.push({ name: "tui-pseudoterminal", command: `external:${process.env.PI_XZ_TUI_EVIDENCE}`, status: tui.childExitCode, elapsedMs: tui.elapsedMs });
	} else {
		const result = run(platform() === "win32" ? "tui-pseudoconsole" : "tui-pseudoterminal", "bun", [join(process.cwd(), "scripts", "smoke-bun-tui.mjs"), executable], { env: tuiEnv, timeout: SMOKE_LIMITS.interactiveMs + 3000 });
		tui = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
	}
	// After the interactive session's paste probe, the tmpdir resource cache
	// must hold the materialized native helper tree. (On Linux the helper only
	// materializes when a display is present; CI provides Xvfb.)
	const cacheRoot = join(isolatedTmp, `pi-resources-${userInfo().uid}`);
	const materializedNative = join(cacheRoot, targetId, expectedVersion, "native");
	let helperPath;
	{
		const stack = existsSync(materializedNative) ? [materializedNative] : [];
		const found = [];
		while (stack.length) {
			const dir = stack.pop();
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) stack.push(full);
				else if (entry.isFile() && entry.name.endsWith(".node")) found.push(full);
			}
		}
		helperPath = found.find((file) => file.endsWith(target.nativeHelperFile));
	}
	commands.push({ name: "resource-materialization", command: `cache:${cacheRoot}`, status: helperPath ? 0 : 1, elapsedMs: 0 });
	if (!helperPath) throw new Error(`materialized native helper tree missing under ${cacheRoot}`);
	let clipboard;
	{
		const nativeClipboard = run("clipboard", "bun", [join(process.cwd(), "scripts", "test-native-clipboard.mjs"), helperPath], { env, maxMs: SMOKE_LIMITS.clipboardMs });
		const clipboardReads = JSON.parse(nativeClipboard.stdout.trim());
		if (clipboardReads.textRead !== true || clipboardReads.imageRead !== true) throw new Error("native clipboard smoke returned invalid evidence");
		clipboard = { helper: helperRelative, sha256: sha256(helperPath), loadedAndCalled: true, ...clipboardReads, elapsedMs: nativeClipboard.elapsedMs };
	}
	if (target.libc === "musl") {
		const provenancePath = join(materializedNative, "..", "clipboard-native-provenance.json");
		if (!existsSync(provenancePath)) throw new Error(`materialized musl provenance missing: ${provenancePath}`);
		run("musl-provenance", process.execPath, [join(process.cwd(), "scripts", "verify-musl-provenance.mjs"), provenancePath, helperPath, targetId], { env });
	}
	const osArchitecture = operatingSystemArchitecture();
	const record = {
		schemaVersion: 1, target: targetId, version: expectedVersion,
		asset: { file: basename(asset), sha256: sha256(asset), bytes: assetBytes },
		runner: { name: process.env.RUNNER_NAME ?? "local", os: process.env.RUNNER_OS ?? platform(), arch: process.env.RUNNER_ARCH ?? osArchitecture, osArchitecture, imageOs: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null, cpuModel: cpus()[0]?.model ?? "unknown", cpuFeatures: cpuFeatures(), libc: target.libc ?? null },
		executor: { kind: process.env.PI_XZ_EXECUTOR ?? "native", containerDigest: process.env.PI_XZ_CONTAINER_DIGEST ?? null, libraries: muslLibraries, emulated: target.emulated },
		commands, tui, clipboard,
		timingsMs: { coldVersion: coldVersion.elapsedMs, version: version.elapsedMs, help: help.elapsedMs, listModels: listModels.elapsedMs, interactive: commands.filter(({ name }) => name.startsWith("tui-")).reduce((sum, entry) => sum + entry.elapsedMs, 0) },
		limits: SMOKE_LIMITS,
	};
	if (osArchitecture !== target.arch) throw new Error(`operating-system architecture ${osArchitecture} does not match ${target.arch}`);
	writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
	console.log(JSON.stringify(record));
} finally { rmSync(work, { recursive: true, force: true }); }
