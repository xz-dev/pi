#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { bunTarget, EMULATED_SMOKE_SLOWDOWN, smokeLimits } from "./lib/bun-targets.mjs";
import { cpuFeatures } from "./lib/cpu-features.mjs";
import { collectMacosCrashReports } from "./lib/macos-crash-reports.mjs";
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
const probeStartedMs = Date.now();
const diagnosticsPath = `${recordPath}.diagnostics`;
const tuiEvidencePath = join(work, "tui-diagnostics.json");
const ownerEvidencePath = join(work, "owner-lifecycle.json");
let ownerLifecycle = null;
// Filled in once the staged executable exists so the outer catch can record the
// exact launch context even for failures after staging.
let stagedExecutable = null;
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
// Failure evidence lands beside (never inside) the smoke record so a green run
// keeps its exact acceptance shape while a red run leaves a bounded diagnostics
// file that survives deletion of the isolated work directory.
function writeFailureDiagnostics(error, context) {
	try {
		let extra;
		try {
			extra = context();
		} catch (contextError) {
			extra = { contextError: contextError instanceof Error ? contextError.message : String(contextError) };
		}
		const diagnostics = {
			schemaVersion: 1,
			target: targetId,
			version: expectedVersion,
			error: error instanceof Error ? error.message : String(error),
			asset: { file: basename(asset), sha256: sha256(asset), bytes: statSync(asset).size },
			// Byte-identical staged copy under its public entrypoint name, hashed
			// independently so a staging defect cannot hide behind the raw hash.
			staged: stagedExecutable && existsSync(stagedExecutable) ? { path: stagedExecutable, sha256: sha256(stagedExecutable), bytes: statSync(stagedExecutable).size } : null,
			runner: {
				name: process.env.RUNNER_NAME ?? "local",
				os: process.env.RUNNER_OS ?? platform(),
				arch: process.env.RUNNER_ARCH ?? null,
				osArchitecture: operatingSystemArchitecture(),
				imageOs: process.env.ImageOS ?? null,
				imageVersion: process.env.ImageVersion ?? null,
				cpuModel: cpus()[0]?.model ?? "unknown",
				cpuFeatures: cpuFeatures(),
			},
			bunRevision: spawnSync("bun", ["--revision"], { encoding: "utf8" }).stdout?.trim() ?? null,
			commands,
			ownerLifecycle: ownerLifecycle ?? (existsSync(ownerEvidencePath) ? JSON.parse(readFileSync(ownerEvidencePath, "utf8")) : null),
			...extra,
		};
		writeFileSync(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`);
	} catch {
		// Diagnostics are best-effort; the original acceptance error stands.
	}
}
function tuiFailureContext(_error, launch) {
	let probe = null;
	try {
		if (existsSync(tuiEvidencePath)) probe = JSON.parse(readFileSync(tuiEvidencePath, "utf8"));
	} catch {
		probe = null;
	}
	let crashReports = [];
	if (platform() === "darwin") {
		const reportDirs = [join(work, "home", "Library", "Logs", "DiagnosticReports"), join(userInfo().homedir, "Library", "Logs", "DiagnosticReports"), "/Library/Logs/DiagnosticReports"];
		if (Number.isSafeInteger(probe?.childPid)) {
			crashReports = collectMacosCrashReports(reportDirs, { pid: probe.childPid, names: ["pi", "bun"], sinceMs: probeStartedMs, untilMs: Date.now() });
		}
	}
	return { launch: { ...launch, cwd: dirname(launch.executable) }, probe, crashReports };
}
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
	stagedExecutable = executable;
	const isolatedTmp = join(work, "tmpdir");
	mkdirSync(isolatedTmp, { recursive: true });
	const env = { ...process.env, NODE_ENV: "production", PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(work, "isolated-agent"), HOME: join(work, "home"), USERPROFILE: join(work, "home"), TMPDIR: isolatedTmp, TEMP: isolatedTmp, TMP: isolatedTmp, TERM: "xterm-256color", PI_XZ_TUI_TIMEOUT_MS: String(SMOKE_LIMITS.interactiveMs) };
	mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
	mkdirSync(join(work, "home"), { recursive: true });
	const tuiEnv = { ...env, PI_XZ_TUI_PASTE_PROBE: "1", PI_XZ_TUI_DIAGNOSTICS: tuiEvidencePath, ...(target.os === "windows" ? { PI_STARTUP_BENCHMARK: "1" } : {}) };
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
	// The owner probe provisions a standard CI user when this host token is privileged.
	const ownerStarted = performance.now();
	const ownerResult = spawnSync(process.execPath, [join(import.meta.dirname, "smoke-owner-lifecycle.mjs"), executable, targetId, ownerEvidencePath], { encoding: "utf8", env, timeout: (target.emulated ? 1_100_000 : 460_000) });
	try { ownerLifecycle = JSON.parse(ownerResult.stdout.trim().split(/\r?\n/).at(-1)); } catch {}
	commands.push({ name: "owner-lifecycle", command: `${process.execPath} smoke-owner-lifecycle.mjs ${executable}`, status: ownerResult.status, elapsedMs: Math.round(performance.now() - ownerStarted) });
	if (ownerResult.status !== 0 || ownerLifecycle?.status !== "passed") throw new Error(`owner lifecycle failed: ${ownerResult.stderr || ownerLifecycle?.error || ownerResult.error?.message || "missing evidence"}`);
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
		// The external probe ran without a display, so it never read the clipboard.
		// Repeat the paste probe here, where DISPLAY and XCB are present, to unfold
		// the native helper into this run's tmpdir.
		const paste = spawnSync("bun", [join(process.cwd(), "scripts", "smoke-bun-tui.mjs"), executable], { encoding: "utf8", env: tuiEnv, timeout: (SMOKE_LIMITS.interactiveMs + 3000) * hangGuardScale });
		if (paste.status !== 0) throw new Error(`paste probe failed (${paste.status ?? paste.signal}): ${paste.stdout ?? ""}${paste.stderr ?? ""}`);
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
		// build-binaries.sh embeds the provenance inside the native tree.
		const provenancePath = join(materializedNative, "clipboard-native-provenance.json");
		if (!existsSync(provenancePath)) throw new Error(`materialized musl provenance missing: ${provenancePath}`);
		run("musl-provenance", process.execPath, [join(process.cwd(), "scripts", "verify-musl-provenance.mjs"), provenancePath, helperPath, targetId], { env });
	}
	const osArchitecture = operatingSystemArchitecture();
	const record = {
		schemaVersion: 1, target: targetId, version: expectedVersion,
		asset: { file: basename(asset), sha256: sha256(asset), bytes: assetBytes },
		runner: { name: process.env.RUNNER_NAME ?? "local", os: process.env.RUNNER_OS ?? platform(), arch: process.env.RUNNER_ARCH ?? osArchitecture, osArchitecture, imageOs: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null, cpuModel: cpus()[0]?.model ?? "unknown", cpuFeatures: cpuFeatures(), libc: target.libc ?? null },
		executor: { kind: process.env.PI_XZ_EXECUTOR ?? "native", containerDigest: process.env.PI_XZ_CONTAINER_DIGEST ?? null, libraries: muslLibraries, emulated: target.emulated, ...(process.env.PI_XZ_UNPINNED_RUST ? { unpinnedRust: process.env.PI_XZ_UNPINNED_RUST } : {}) },
		commands, tui, clipboard, ownerLifecycle,
		timingsMs: { coldVersion: coldVersion.elapsedMs, version: version.elapsedMs, help: help.elapsedMs, listModels: listModels.elapsedMs, interactive: commands.filter(({ name }) => name.startsWith("tui-")).reduce((sum, entry) => sum + entry.elapsedMs, 0) },
		limits: SMOKE_LIMITS,
	};
	if (osArchitecture !== target.arch) throw new Error(`operating-system architecture ${osArchitecture} does not match ${target.arch}`);
	writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
	console.log(JSON.stringify(record));
} catch (error) {
	// Context construction runs inside the diagnostics' own try: an OS-account
	// or collection fault must never replace the original acceptance error.
	writeFailureDiagnostics(error, () => (stagedExecutable ? tuiFailureContext(error, { command: ["bun", "scripts/smoke-bun-tui.mjs"].join(" "), executable: stagedExecutable }) : {}));
	throw error;
} finally { rmSync(work, { recursive: true, force: true }); }
