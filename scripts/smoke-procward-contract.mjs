#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { validateProcwardPin } from "./acquire-procward.mjs";
import { bunTarget, EMULATED_SMOKE_SLOWDOWN, isMainModulePath } from "./lib/bun-targets.mjs";
import { PROCWARD_PIN } from "./lib/procward-pin.mjs";

const fixtures = fileURLToPath(new URL("./fixtures/procward/", import.meta.url));
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
export const PROCWARD_CONTRACT_CASES = Object.freeze(["bundle-pin", "auto-wrap", "external-default-nesting", "pi-in-pi-default-nesting", "flag-opt-out", "env-opt-out", "option-value", "after-terminator", "external-opt-out", "external-env-opt-out", "nested-flag-opt-out", "nested-env-opt-out", "stale-marker", "access-boundary", "notice-hook", "blocked-hook", "terminal-restored"]);
export function assertProcwardContract(record, targetId, piSha256, pin = PROCWARD_PIN) {
	const target = bunTarget(targetId).cargoTarget;
	if (!/^[0-9a-f]{64}$/.test(pin.targets[target]?.zipSha256 ?? "") || !/^[0-9a-f]{64}$/.test(pin.targets[target]?.binarySha256 ?? "")) throw new Error(`${targetId} missing procward pin digests`);
	const expected = { state: pin.state, version: pin.version, repository: pin.repository, workflow: pin.workflow, sourceCommit: pin.sourceCommit, tag: pin.tag, target, ...pin.targets[target] };
	if (record?.schemaVersion !== 1 || record.status !== "passed" || record.target !== targetId || record.piSha256 !== piSha256 || !/^[0-9a-f]{64}$/.test(piSha256) || !isDeepStrictEqual(record.procward, expected)) throw new Error(`${targetId} procward contract identity mismatch`);
	if (JSON.stringify(record.cases?.map((entry) => entry.name)) !== JSON.stringify(PROCWARD_CONTRACT_CASES) || record.cases.some((entry) => entry.passed !== true)) throw new Error(`${targetId} incomplete procward integration contract`);
	for (const hook of [record.notice, record.blocked]) {
		if (hook?.noticeOnly !== true || hook.parentAlive !== true || hook.hookRan !== true || hook.terminalRestored !== true || JSON.stringify(hook.terminalBefore) !== JSON.stringify(hook.terminalAfter) || !Number.isSafeInteger(hook.elapsedMs) || hook.elapsedMs < 0) throw new Error(`${targetId} invalid procward notice/terminal evidence`);
	}
	const scale = bunTarget(targetId).emulated ? EMULATED_SMOKE_SLOWDOWN : 1;
	const access = record.access;
	if (typeof access?.mechanism !== "string" || access.okStatus !== 0 || !Number.isSafeInteger(access.commandStatus) || access.commandStatus === 0 || access.piStatus !== access.commandStatus || access.lingerReaped !== true || (bunTarget(targetId).os === "windows" && access.denied !== true)) throw new Error(`${targetId} invalid procward access-boundary evidence`);
	if (record.notice.blockedHook !== false || record.blocked.blockedHook !== true || record.blocked.elapsedMs < 4500 || record.blocked.elapsedMs >= 6500 * scale) throw new Error(`${targetId} missing original 5s hook bound`);
}

// A descendant the controller may not inspect or open must neither kill procward nor escape cleanup.
export function procwardAccessBoundary(executable, env, work, scale = 1) {
	const python = process.platform === "win32" ? "python" : process.platform === "freebsd" ? "python3.11" : "python3";
	const windows = process.platform === "win32";
	const directory = join(work, "access-boundary");
	mkdirSync(directory);
	const ready = join(directory, "linger.ready");
	const linger = [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready\\n"); setInterval(() => {}, 1 << 30);`];
	let spec, launch = executable, extension = join(fixtures, "extension.mjs"), extra = {}, drop = {};
	if (windows) {
		const script = join(fixtures, "access-boundary.py");
		spec = { mechanism: "process DACL denies the controller", ok: [python, script, "exit", "0"], fail: [python, script, "exit", "7"], linger: [python, script, "linger", ready], check: [python, script, "check"] };
	} else if (process.getuid() === 0) {
		// A root controller crosses no boundary: run Pi as nobody and give it a setuid-root runtime to start.
		chmodSync(work, 0o711);
		for (const path of [directory, ...["home", "tmp"].map((name) => join(directory, name))]) { mkdirSync(path, { recursive: true }); chmodSync(path, 0o777); }
		const setuid = join(directory, "setuid-runtime");
		copyFileSync(process.execPath, setuid); chmodSync(setuid, 0o4755);
		launch = join(directory, basename(executable)); copyFileSync(executable, launch); chmodSync(launch, 0o755);
		extension = join(directory, "extension.mjs"); copyFileSync(join(fixtures, "extension.mjs"), extension); chmodSync(extension, 0o644);
		const euid = (code) => `process.exit(process.geteuid() === 0 && process.getuid() !== 0 ? ${code} : 3)`;
		spec = { mechanism: "setuid-root runtime started by uid 65534", ok: [setuid, "-e", euid(0)], fail: [setuid, "-e", euid(7)], linger };
		const home = join(directory, "home"), tmp = join(directory, "tmp");
		extra = { HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
		drop = { uid: 65534, gid: 65534 };
	} else if (process.platform === "darwin") {
		spec = { mechanism: "setuid-root /bin/ps", ok: ["/bin/ps", "-p", "1", "-o", "pid="], fail: ["/bin/ps", "-p", "2147483646"], linger };
	} else {
		spec = { mechanism: "setuid-root sudo -n", ok: ["/usr/bin/sudo", "-n", "/bin/sh", "-c", 'test "$(id -u)" = 0'], fail: ["/usr/bin/sudo", "-n", "/bin/sh", "-c", 'test "$(id -u)" = 0 && exit 7'], linger };
	}
	if (!windows) {
		const mode = statSync(spec.ok[0]);
		if (!(mode.mode & 0o4000) || mode.uid !== 0) throw new Error(`procward contract failed: access-boundary ${spec.ok[0]} is not setuid root`);
	}
	const cliArgs = ["--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "-e", extension, "--help"];
	const result = spawnSync(launch, cliArgs, { env: { ...env, ...extra, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_PROCWARD_CONTRACT_DIRECTORY: directory, PI_PROCWARD_CONTRACT_PROBE: "1", PI_PROCWARD_CONTRACT_ACCESS: JSON.stringify({ ...spec, ready }) }, encoding: "utf8", timeout: 30000 * scale, maxBuffer: 4 * 1024 * 1024, ...drop });
	const file = join(directory, "access.json");
	if (!existsSync(file)) throw new Error(`procward contract failed: access-boundary wrote no record (${result.status ?? result.signal}): ${result.error?.message ?? ""}\n${result.stderr ?? ""}${(result.stdout ?? "").slice(-2000)}`);
	const record = JSON.parse(readFileSync(file, "utf8"));
	const alive = (pid) => {
		if (windows) return spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8" }).stdout.includes(`"${pid}"`);
		try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
	};
	const pause = new Int32Array(new SharedArrayBuffer(4));
	let lingerReaped = false;
	for (let i = 0; i < 40 && !(lingerReaped = !alive(record.linger)); i++) Atomics.wait(pause, 0, 0, 50);
	if (!lingerReaped) try { process.kill(record.linger, "SIGKILL"); } catch {}
	const evidence = { mechanism: spec.mechanism, okStatus: record.ok.status, commandStatus: record.fail.status, piStatus: result.status, lingerReaped, ...(windows ? { denied: record.check?.status === 0 } : {}) };
	if (!record.ready || evidence.okStatus !== 0 || !evidence.commandStatus || evidence.piStatus !== evidence.commandStatus || !lingerReaped || (windows && !evidence.denied)) throw new Error(`procward contract failed: access-boundary ${JSON.stringify({ evidence, record, stderr: (result.stderr ?? "").slice(-2000) })}`);
	return evidence;
}
export function smokeProcwardContract(executable, targetId, version, { allowDev = false } = {}) {
	const pin = validateProcwardPin(PROCWARD_PIN, { allowDev });
	const descriptor = bunTarget(targetId);
	const expected = pin.targets[descriptor.cargoTarget];
	if (!expected) throw new Error(`No procward development asset for ${targetId}`);
	const scale = descriptor.emulated ? EMULATED_SMOKE_SLOWDOWN : 1;
	const work = mkdtempSync(join(tmpdir(), "pi-procward-contract-"));
	const python = process.platform === "win32" ? "python" : process.platform === "freebsd" ? "python3.11" : "python3";
	const env = { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_NO_PROCESS_OWNERSHIP: "", PI_PROCWARD_CONTRACT_HARNESS_PID: String(process.pid), PI_PROCWARD_CONTRACT_RUNTIME: process.execPath, PI_PROCWARD_CONTRACT_TOPOLOGY: join(fixtures, "topology.mjs"), TERM: "xterm-256color" };
	for (const key of Object.keys(env)) if (key.startsWith("PROCWARD_") || key.startsWith("PI_PROCESS_OWNER_") || key === "PI_PACKAGE_DIR" || key === "PI_PROCWARD_BOOTSTRAP_PENDING" || key === "PI_PROCWARD_BOOTSTRAP_NONCE") delete env[key];
	const isolatedTmp = join(work, "tmp");
	mkdirSync(isolatedTmp);
	Object.assign(env, { HOME: join(work, "home"), USERPROFILE: join(work, "home"), TMPDIR: isolatedTmp, TMP: isolatedTmp, TEMP: isolatedTmp });
	mkdirSync(env.HOME);
	const cases = [];
	const passed = (name, proof) => { if (!proof) throw new Error(`procward contract failed: ${name}`); cases.push({ name, passed: true }); };
	function run(command, args, extra = {}, timeout = 30000) {
		const result = spawnSync(command, args, { env: { ...env, ...extra }, encoding: "utf8", timeout: timeout * scale, maxBuffer: 4 * 1024 * 1024 });
		if (result.error || result.status !== 0) throw new Error(`procward contract command failed (${result.status ?? result.signal}): ${result.error?.message ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
		return result;
	}
	function probe(name, args = [], extra = {}, owner) {
		const directory = join(work, name);
		mkdirSync(directory);
		const cliArgs = ["--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "-e", join(fixtures, "extension.mjs"), "--help", ...args];
		const result = owner ? run(owner, ["run", "--", executable, ...cliArgs], { ...extra, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_PROCWARD_CONTRACT_DIRECTORY: directory, PI_PROCWARD_CONTRACT_PROBE: "1" }) : run(executable, cliArgs, { ...extra, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_PROCWARD_CONTRACT_DIRECTORY: directory, PI_PROCWARD_CONTRACT_PROBE: "1" });
		const probeFile = join(directory, "probe.json");
		// The CLI can exit 0 after an extension load error; keep its diagnostics with the failure.
		if (!existsSync(probeFile)) throw new Error(`procward contract probe ${name} wrote no record:\n${result.stderr ?? ""}${(result.stdout ?? "").slice(-2000)}`);
		const lines = readFileSync(probeFile, "utf8").trim().split("\n");
		if (lines.length !== 1) throw new Error("CLI extension graph loaded more than once");
		const record = JSON.parse(lines[0]);
		if (record.metadata.length) throw new Error("procward metadata leaked into extensions");
		return { ...record, launcherPid: result.pid };
	}
	try {
		// A broken executable at the front of PATH proves compiled assets cannot substitute it.
		const pathSentinel = join(work, "path"); mkdirSync(pathSentinel);
		const fake = join(pathSentinel, process.platform === "win32" ? "procward.exe" : "procward");
		writeFileSync(fake, "not an executable procward\n"); chmodSync(fake, 0o700);
		env.PATH = `${pathSentinel}${process.platform === "win32" ? ";" : ":"}${env.PATH ?? ""}`;
		const direct = probe("direct");
		const cache = join(isolatedTmp, `pi-resources-${userInfo().uid}`, targetId, version, "procward", `${pin.version}-${expected.binarySha256}`);
		const helper = join(cache, descriptor.os === "windows" ? "procward.exe" : "procward");
		const manifest = JSON.parse(readFileSync(join(cache, "pin.json"), "utf8"));
		const procward = { state: pin.state, version: pin.version, repository: pin.repository, workflow: pin.workflow, sourceCommit: pin.sourceCommit, tag: pin.tag, target: descriptor.cargoTarget, ...expected };
		const helperVersion = run(helper, ["--version"]).stdout.trim();
		passed("bundle-pin", isDeepStrictEqual(manifest, procward) && digest(helper) === expected.binarySha256 && helperVersion === `procward ${pin.version}` && ["LICENSE", "README.md", "third-party-licenses.md"].every((file) => existsSync(join(cache, file)) && readFileSync(join(cache, file)).length) && ["LICENSE", "third-party-licenses.md"].every((file) => readFileSync(join(cache, file)).equals(readFileSync(join(import.meta.dirname, "vendor/procward", file)))));
		const baseline = JSON.parse(run(helper, ["run", "--", process.execPath, join(fixtures, "topology.mjs")]).stdout.trim());
		passed("auto-wrap", baseline.ownerLayers > 0 && direct.topology.ownerLayers === baseline.ownerLayers && typeof direct.taskOwner === "string");
		const external = probe("external", [], {}, helper);
		passed("external-default-nesting", external.topology.ownerLayers === 2 * baseline.ownerLayers && typeof external.taskOwner === "string");
		const nested = probe("nested", [], { PI_PROCWARD_CONTRACT_NEST: "1" });
		passed("pi-in-pi-default-nesting", nested.topology.ownerLayers === 2 * baseline.ownerLayers && typeof nested.taskOwner === "string");
		for (const [name, args, extra] of [["flag-opt-out", ["--no-process-ownership"], {}], ["env-opt-out", [], { PI_NO_PROCESS_OWNERSHIP: "1" }]]) {
			const record = probe(name, args, extra);
			passed(name, record.topology.ownerLayers === 0 && record.pid === record.launcherPid && record.taskOwner === undefined);
		}
		for (const [name, args] of [["option-value", ["--system-prompt", "--no-process-ownership"]], ["after-terminator", ["--", "--no-process-ownership"]]]) {
			const record = probe(name, args);
			passed(name, record.topology.ownerLayers === baseline.ownerLayers && typeof record.taskOwner === "string");
		}
		const externalDisabled = probe("external-disabled", ["--no-process-ownership"], {}, helper);
		passed("external-opt-out", externalDisabled.topology.ownerLayers === baseline.ownerLayers && externalDisabled.taskOwner === undefined);
		const externalEnvDisabled = probe("external-env-disabled", [], { PI_NO_PROCESS_OWNERSHIP: "1" }, helper);
		passed("external-env-opt-out", externalEnvDisabled.topology.ownerLayers === baseline.ownerLayers && externalEnvDisabled.taskOwner === undefined);
		for (const mode of ["flag", "env"]) {
			const record = probe(`nested-${mode}`, [], { PI_PROCWARD_CONTRACT_NEST: mode });
			passed(`nested-${mode}-opt-out`, record.topology.ownerLayers === baseline.ownerLayers && record.taskOwner === undefined);
		}
		const stale = spawnSync(executable, ["--version"], { env: { ...env, PI_PROCWARD_BOOTSTRAP_NONCE: "a".repeat(32) }, encoding: "utf8", timeout: 10000 * scale });
		passed("stale-marker", !stale.error && stale.status !== 0 && stale.stdout === "" && stale.stderr.trim().split("\n").length === 1 && stale.stderr.includes("unset PI_PROCWARD_BOOTSTRAP_NONCE") && stale.stderr.includes("--no-process-ownership / PI_NO_PROCESS_OWNERSHIP=1"));
		const access = procwardAccessBoundary(executable, env, work, scale);
		passed("access-boundary", true);
		const harness = join(fixtures, process.platform === "win32" ? "conpty-contract.py" : "pty-contract.py");
		const terminalContract = (directory, block) => process.env.PI_PROCWARD_CONTRACT_PTY
			? JSON.parse(run(process.env.PI_PROCWARD_CONTRACT_PTY, [executable, join(fixtures, "extension.mjs"), directory, block, String(scale)], {}, 40000).stdout.trim())
			: JSON.parse(run(python, [harness, JSON.stringify([executable]), join(fixtures, "extension.mjs"), directory, block, String(scale)], {}, 40000).stdout.trim());
		const notice = terminalContract(join(work, "notice"), "0");
		passed("notice-hook", notice.noticeOnly && notice.parentAlive && notice.hookRan);
		const blocked = terminalContract(join(work, "blocked"), "1");
		passed("blocked-hook", blocked.hookRan && blocked.elapsedMs >= 4500 && blocked.elapsedMs < 6500 * scale);
		passed("terminal-restored", notice.terminalRestored && blocked.terminalRestored);
		const record = { schemaVersion: 1, status: "passed", target: targetId, piSha256: digest(executable), procward, cases, access, notice, blocked };
		assertProcwardContract(record, targetId, record.piSha256);
		return record;
	} finally { rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1] && isMainModulePath(fileURLToPath(import.meta.url), process.argv[1])) {
	const [executable, target, version, output, ...rest] = process.argv.slice(2);
	if (!executable || !target || !version || !output || rest.some((arg) => arg !== "--allow-dev")) throw new Error("Usage: smoke-procward-contract.mjs <pi> <target> <version> <record.json> [--allow-dev]");
	const record = smokeProcwardContract(resolve(executable), target, version, { allowDev: rest.includes("--allow-dev") });
	mkdirSync(dirname(resolve(output)), { recursive: true });
	writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
	console.log(JSON.stringify(record));
}
