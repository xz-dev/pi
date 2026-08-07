#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bunTarget, SMOKE_LIMITS } from "./lib/bun-targets.mjs";
import { operatingSystemArchitecture } from "./lib/runtime-architecture.mjs";

const [archiveArg, targetId, expectedVersion, recordArg] = process.argv.slice(2);
if (!archiveArg || !targetId || !expectedVersion || !recordArg) throw new Error("Usage: smoke-binary-release.mjs <archive> <target> <version> <record.json>");
const target = bunTarget(targetId);
const archive = resolve(archiveArg);
const recordPath = resolve(recordArg);
const work = mkdtempSync(join(tmpdir(), "pi-binary-smoke-"));
const commands = [];
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function run(name, command, args, options = {}) {
	const started = performance.now();
	const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeout ?? 10_000, env: options.env });
	const elapsedMs = Math.round(performance.now() - started);
	commands.push({ name, command: [command, ...args].join(" "), status: result.status, elapsedMs });
	if (result.status !== 0) throw new Error(`${name} failed (${result.status}): ${result.stdout ?? ""}${result.stderr ?? ""}`);
	if (options.maxMs && elapsedMs > options.maxMs) throw new Error(`${name} ${elapsedMs}ms exceeds ${options.maxMs}ms`);
	return { stdout: result.stdout ?? "", elapsedMs };
}
function directoryBytes(root) {
	const script = "const fs=require('node:fs'),p=require('node:path');let n=0;for(const d of fs.readdirSync(process.argv[1],{recursive:true,withFileTypes:true})){if(d.isFile())n+=fs.statSync(p.join(d.parentPath??d.path,d.name)).size}console.log(n)";
	return Number(run("measure-extracted-size", process.execPath, ["-e", script, root]).stdout.trim());
}
function cpuFeatures() {
	if (platform() === "linux") return readFileSync("/proc/cpuinfo", "utf8").match(/^Features\s*:.*|^flags\s*:.*$/m)?.[0] ?? "unknown";
	if (platform() === "darwin") return spawnSync("sysctl", ["-n", "machdep.cpu.features", "machdep.cpu.leaf7_features"], { encoding: "utf8" }).stdout.trim();
	return cpus()[0]?.model ?? "unknown";
}
try {
	const archiveBytes = statSync(archive).size;
	if (archiveBytes > SMOKE_LIMITS.archiveBytes) throw new Error(`archive size ${archiveBytes} exceeds ${SMOKE_LIMITS.archiveBytes}`);
	run("extract", "tar", target.os === "windows" ? ["-xf", archive, "-C", work] : ["-xzf", archive, "-C", work]);
	const root = target.os === "windows" ? work : join(work, "pi");
	const extractedBytes = directoryBytes(root);
	if (extractedBytes > SMOKE_LIMITS.extractedBytes) throw new Error(`extracted size ${extractedBytes} exceeds ${SMOKE_LIMITS.extractedBytes}`);
	const executable = join(root, target.executable);
	const env = { ...process.env, NODE_ENV: "production", PI_CODING_AGENT_DIR: join(work, "isolated-agent"), TERM: "xterm-256color" };
	const version = run("version", executable, ["--version"], { env, maxMs: SMOKE_LIMITS.versionMs });
	if (version.stdout.trim() !== expectedVersion) throw new Error(`version mismatch: ${version.stdout.trim()}`);
	const help = run("help", executable, ["--help"], { env, maxMs: SMOKE_LIMITS.helpMs });
	if (!help.stdout.includes("Usage") && !help.stdout.includes("pi")) throw new Error("help output was not recognized");
	const listModels = run("list-models", executable, ["--list-models"], { env, maxMs: SMOKE_LIMITS.listModelsMs });
	if (!listModels.stdout.trim()) throw new Error("list-models produced no output");
	const noticesPath = join(root, "THIRD_PARTY_NOTICES.md");
	const notices = readFileSync(noticesPath, "utf8");
	if (!notices.startsWith("# Third-Party Notices") || !notices.includes("License SHA-256:")) throw new Error("third-party notices are missing or invalid");
	const addon = join(root, "node_modules", "@mariozechner", "clipboard", target.clipboardNativeFile);
	const clipboard = run("clipboard", "bun", ["-e", "const c=require(process.argv[1]);if(typeof c.hasImage!=='function')process.exit(2);c.hasImage()", addon], { env });
	if (target.libc === "musl") run("musl-provenance", "bun", [join(process.cwd(), "scripts", "verify-musl-provenance.mjs"), join(root, "clipboard-native-provenance.json"), addon, targetId], { env });
	let tui;
	if (process.env.PI_XZ_TUI_EVIDENCE) {
		tui = JSON.parse(readFileSync(process.env.PI_XZ_TUI_EVIDENCE, "utf8"));
		if (tui.harness !== "Python standard-library PTY" || !Number.isSafeInteger(tui.elapsedMs) || tui.elapsedMs < 0 || tui.elapsedMs > SMOKE_LIMITS.interactiveMs || !Number.isSafeInteger(tui.outputBytes) || tui.outputBytes <= 0 || tui.input !== "ctrl-c,ctrl-d" || tui.childExitCode !== 0 || !tui.observedOutput || !tui.exitSent || !tui.cleanExit) throw new Error("invalid external TUI evidence");
		commands.push({ name: "tui-pseudoterminal", command: `external:${process.env.PI_XZ_TUI_EVIDENCE}`, status: tui.childExitCode, elapsedMs: tui.elapsedMs });
	} else if (platform() === "win32") {
		const tuiResult = run("tui-pseudoconsole", "powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(process.cwd(), "scripts", "smoke-windows-tui.ps1"), "-Executable", executable, "-Record", join(work, "windows-tui.json")], { env, timeout: SMOKE_LIMITS.interactiveMs + 3000 });
		tui = JSON.parse(tuiResult.stdout.trim().split(/\r?\n/).at(-1));
	} else {
		const result = run("tui-pseudoterminal", "python3", [join(process.cwd(), "scripts", "smoke-unix-tui.py"), executable], { env, timeout: SMOKE_LIMITS.interactiveMs + 3000 });
		tui = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
	}
	const osArchitecture = operatingSystemArchitecture();
	const record = {
		schemaVersion: 1, target: targetId, version: expectedVersion,
		archive: { file: archive.split(/[\\/]/).at(-1), sha256: sha256(archive), bytes: archiveBytes, extractedBytes },
		runner: { name: process.env.RUNNER_NAME ?? "local", os: process.env.RUNNER_OS ?? platform(), arch: process.env.RUNNER_ARCH ?? osArchitecture, osArchitecture, imageOs: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null, cpuModel: cpus()[0]?.model ?? "unknown", cpuFeatures: cpuFeatures(), libc: target.libc ?? null },
		executor: { kind: process.env.PI_XZ_EXECUTOR ?? "native", containerDigest: process.env.PI_XZ_CONTAINER_DIGEST ?? null, emulated: false },
		commands, tui, clipboard: { addon: target.clipboardNativeFile, loadedAndCalled: true, elapsedMs: clipboard.elapsedMs },
		thirdPartyNotices: { file: "THIRD_PARTY_NOTICES.md", sha256: sha256(noticesPath), bytes: statSync(noticesPath).size },
		timingsMs: { version: version.elapsedMs, help: help.elapsedMs, listModels: listModels.elapsedMs, interactive: commands.filter(({ name }) => name.startsWith("tui-")).reduce((sum, entry) => sum + entry.elapsedMs, 0) },
		limits: SMOKE_LIMITS,
	};
	if (osArchitecture !== target.arch) throw new Error(`operating-system architecture ${osArchitecture} does not match ${target.arch}`);
	writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
	console.log(JSON.stringify(record));
} finally { rmSync(work, { recursive: true, force: true }); }
