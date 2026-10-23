#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bunTarget, isMainModulePath } from "./lib/bun-targets.mjs";
import { assertUnixOwnerPtyRow, isUnixOwnerPtyRow, smokeUnixOwnerPty, unixOwnerFaultRows } from "./smoke-unix-owner-pty.mjs";
import { assertWindowsOwnerGate, smokeWindowsOwnerGate, stageWindowsOwnerGate } from "./smoke-windows-owner-gate.mjs";

// Absolute System32 paths: Git for Windows puts GNU coreutils (e.g. whoami) on PATH.
const windowsTool = (name) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
function query(command, args) {
	// Cold PowerShell start on hosted Windows arm64 runners exceeds 10s.
	const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000 });
	if (result.status !== 0) throw new Error(`${command}: ${result.stderr || result.error?.message || result.status}`);
	return result.stdout.trim();
}

export function ownerIdentity() {
	if (process.platform === "win32") {
		const token = JSON.parse(query(windowsTool("WindowsPowerShell\\v1.0\\powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", "$i=[Security.Principal.WindowsIdentity]::GetCurrent(); $p=New-Object Security.Principal.WindowsPrincipal($i); @{name=$i.Name; elevated=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); groups=@($i.Groups | ForEach-Object {$_.Value})} | ConvertTo-Json -Compress"]));
		const groups = query(windowsTool("whoami.exe"), ["/groups", "/fo", "csv"]);
		return { ...token, tokenGroups: groups, mediumIntegrity: /S-1-16-8192\b/.test(groups), adminGroup: token.groups.includes("S-1-5-32-544"), elevated: token.elevated || /S-1-16-(12288|16384)/.test(groups) };
	}
	const identity = { uid: process.getuid(), euid: process.geteuid(), gid: process.getgid(), egid: process.getegid(), groups: process.getgroups(), credentials: query("id", []), elevated: process.getuid() === 0 || process.geteuid() === 0 };
	if (process.platform === "linux") {
		identity.capabilities = Object.fromEntries([...readFileSync("/proc/self/status", "utf8").matchAll(/^(Cap\w+):\s*([0-9a-f]+)$/gm)].map((match) => [match[1], match[2]]));
		if (!["CapPrm", "CapEff", "CapAmb"].every((key) => /^[0-9a-f]+$/.test(identity.capabilities[key] ?? ""))) throw new Error("Linux capability evidence missing");
		identity.elevated ||= ["CapPrm", "CapEff", "CapAmb"].some((key) => BigInt(`0x${identity.capabilities[key]}`) !== 0n);
		identity.groupNames = query("id", ["-Gn"]).split(/\s+/);
		// Root-equivalent groups: sudo/wheel/admin grant root, docker/lxd grant a root container. Hosted CI runners have them.
		identity.rootEquivalentGroup = identity.groupNames.some((name) => ["root", "sudo", "wheel", "admin", "docker", "lxd"].includes(name));
	} else if (process.platform === "freebsd") {
		identity.groupNames = query("id", ["-Gn"]).split(/\s+/);
		identity.adminGroup = identity.groupNames.some((name) => name === "wheel" || name === "operator");
		// FreeBSD has Capsicum capability mode, not Linux capability bitsets.
		identity.capabilities = { kind: "Capsicum/credential flags", procstat: query("procstat", ["-s", String(process.pid)]) };
	} else if (process.platform === "darwin") {
		identity.groupNames = query("id", ["-Gn"]).split(/\s+/);
		identity.adminGroup = identity.groupNames.includes("admin");
	} else throw new Error(`owner identity unsupported: ${process.platform}`);
	return identity;
}

// Exactly one post-exit lookup. Zombies cannot run; permission/query errors are failures, not absence.
export function ownerProcessAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`invalid fixture PID: ${pid}`);
	if (process.platform === "linux") {
		try { return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); }
		catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return false; throw error; }
	}
	if (process.platform === "win32") {
		return query(windowsTool("WindowsPowerShell\\v1.0\\powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) {'alive'} else {'gone'}`]) === "alive";
	}
	const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 10_000 });
	if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) return false;
	if (result.status !== 0 || !result.stdout.trim()) throw new Error(`PID lookup failed: ${result.stderr || result.error?.message || result.status}`);
	return !result.stdout.trim().startsWith("Z");
}

export function assertNonadminIdentity(identity, os) {
	if (identity?.elevated !== false || identity.adminGroup === true || identity.rootEquivalentGroup === true || (os === "windows" && identity.mediumIntegrity !== true)) throw new Error("owner lifecycle missing nonadmin identity");
	if (os !== "windows") {
		if (![identity.uid, identity.euid, identity.gid, identity.egid].every((n) => Number.isSafeInteger(n) && n > 0) || !Array.isArray(identity.groups) || identity.groups.some((n) => !Number.isSafeInteger(n) || n <= 0) || !Array.isArray(identity.groupNames) || identity.groupNames.some((name) => ["root", "sudo", "wheel", "admin", "operator", "docker", "lxd"].includes(name))) throw new Error("owner lifecycle missing nonadmin identity: Unix credentials/groups");
		if (os === "linux" && !["CapPrm", "CapEff", "CapAmb"].every((key) => /^[0-9a-f]+$/.test(identity.capabilities?.[key] ?? "") && BigInt(`0x${identity.capabilities[key]}`) === 0n)) throw new Error("owner lifecycle missing nonadmin identity: Linux capabilities");
	}
}

export function ownerPrivilegeDropRequired(platform, identity, env) {
	// The musl container receives only PI_XZ_* from the workflow, not CI/GITHUB_ACTIONS.
	return (env.CI === "true" || env.GITHUB_ACTIONS === "true" || ["pinned-musl-container", "freebsd-vm"].includes(env.PI_XZ_EXECUTOR)) &&
		["linux", "freebsd", "darwin", "win32"].includes(platform) &&
		(identity.uid === 0 || identity.euid === 0 || identity.elevated === true || identity.adminGroup === true || identity.rootEquivalentGroup === true);
}

export function artifactBunFromOwnerRows(rows) {
	const missing = rows.filter((row) => typeof row.pi?.bun !== "string" || !row.pi.bun.trim()).map(({ name }) => name);
	const versions = [...new Set(rows.map((row) => row.pi?.bun).filter((version) => typeof version === "string" && version.trim()))];
	const reasons = [];
	if (!rows.length) reasons.push("no owner rows");
	if (missing.length) reasons.push(`missing embedded Bun version: ${missing.join(", ")}`);
	if (versions.length > 1) reasons.push(`owner rows disagree on embedded Bun version: ${versions.join(", ")}`);
	return { artifactBunVersion: reasons.length ? null : versions[0], artifactBunError: reasons.join("; ") || null };
}

export function ownerLifecycleRows(os) {
	return ["normal-double-fork", "kill-double-fork", "normal-setsid", "kill-setsid", ...(os === "darwin" ? ["darwin-fast-escape"] : []), ...(os !== "windows" ? ["suspend-resume", ...unixOwnerFaultRows(os)] : []), "ownership-disabled"];
}

export function assertOwnerLifecycle(evidence, os, targetId = evidence?.target, cliSha256 = evidence?.cliSha256) {
	assertNonadminIdentity(evidence?.identity, os);
	const expected = ownerLifecycleRows(os);
	if (JSON.stringify(evidence.rows?.map(({ name }) => name)) !== JSON.stringify(expected)) throw new Error("owner lifecycle row inventory mismatch");
	for (const row of evidence.rows) {
		if (row.guardExpired === true || row.aliveBefore !== true || row.peerAlive !== true || row.immediateChecks !== 1 || typeof row.aliveAfter !== "boolean") throw new Error(`owner lifecycle invalid observation: ${row.name}`);
		if (row.name === "darwin-fast-escape") {
			if (row.status !== "known-limitation" || !row.limitation) throw new Error("Darwin fast escape must be labeled known-limitation");
		} else if (row.status !== "passed" || row.aliveAfter !== false) throw new Error(`owner lifecycle containment failed: ${row.name}`);
		if (row.name === "suspend-resume" && (row.piStopped !== true || row.stopped !== true || row.resumed !== true || row.peerRunning !== true)) throw new Error("owner lifecycle suspend/resume missing proof");
		if (os !== "windows" && isUnixOwnerPtyRow(row.name)) assertUnixOwnerPtyRow(row, os, evidence.identity, targetId, cliSha256);
		if (row.name === "ownership-disabled" && row.ownershipDisabled !== true) throw new Error("owner lifecycle opt-out missing proof");
	}
	{
		const { artifactBunVersion, artifactBunError } = artifactBunFromOwnerRows(evidence.rows);
		if (!artifactBunVersion || evidence.artifactBunVersion !== artifactBunVersion) throw new Error(`owner lifecycle artifact Bun version invalid: ${artifactBunError ?? "differs from owner rows"}`);
	}
	if (evidence.status !== "passed") throw new Error("owner lifecycle did not pass");
}

export async function smokeOwnerLifecycle(executable, target, { timeoutMs = 60_000, windowsGateRoot = process.env.PI_WINDOWS_GATE_ROOT, runPty = smokeUnixOwnerPty, identityProbe = ownerIdentity } = {}) {
	const started = performance.now();
	const evidence = { status: "failed", target: target.id, cliSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"), identity: null, rows: [], ...artifactBunFromOwnerRows([]), path: "ownCliProcesses + explicit extension factory; no model, prompt or API", peerPid: null };
	try { evidence.identity = identityProbe(); assertNonadminIdentity(evidence.identity, target.os); }
	catch (error) { evidence.error = error.message; return evidence; }
	const work = mkdtempSync(join(tmpdir(), "pi-owner-smoke-"));
	const fixtures = fileURLToPath(new URL("./fixtures/owner/", import.meta.url));
	const peer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	const peerStarted = new Promise((resolve, reject) => { peer.once("spawn", resolve); peer.once("error", reject); });
	try {
		await peerStarted;
		evidence.peerPid = peer.pid;
		for (const name of ownerLifecycleRows(target.os)) {
			if (target.os !== "windows" && isUnixOwnerPtyRow(name)) {
				evidence.rows.push(runPty(executable, target, name, join(work, name), evidence.identity));
				continue;
			}
			const pidFile = join(work, `${name}.pid`);
			const ready = join(work, `${name}.ready`);
			const release = join(work, `${name}.release`);
			const row = { name, status: "failed", immediateChecks: 0 };
			evidence.rows.push(row);
			const env = { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: work, HOME: work, USERPROFILE: work, PI_OWNER_RUNTIME: process.execPath, PI_OWNER_FIXTURES: fixtures, PI_OWNER_PID_FILE: pidFile, PI_OWNER_READY: ready, PI_OWNER_RELEASE: release, PI_OWNER_CASE: name === "suspend-resume" ? name : name === "darwin-fast-escape" ? "fast-escape" : name.endsWith("double-fork") ? "double-fork" : "setsid", PI_OWNER_PAUSE: join(work, `${name}.pause`) };
			for (const key of ["PI_PROCESS_OWNER_PID", "PI_PROCESS_OWNER_PENDING", "PI_PROCESS_OWNER_BINARY", "PI_NO_PROCESS_OWNERSHIP", "PI_STARTUP_BENCHMARK"]) delete env[key];
			if (name === "ownership-disabled") env.PI_OWNER_CASE = "ownership-disabled";
			const child = spawn(executable, ["-p", ...(name === "ownership-disabled" ? ["--no-process-ownership"] : []), "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", join(fixtures, "extension.mjs")], { cwd: work, env, detached: false, stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2048); });
			let exited = false;
			const completion = new Promise((resolve) => {
				child.once("error", (error) => { exited = true; resolve({ error: error.message }); });
				child.once("close", (code, signal) => { exited = true; resolve({ code, signal }); });
			});
			let guardExpired = false;
			const guard = setTimeout(() => { guardExpired = true; child.kill("SIGKILL"); }, timeoutMs);
			let pid;
			try {
				const deadline = Date.now() + timeoutMs;
				while (!existsSync(ready)) {
					if (exited || Date.now() >= deadline) throw new Error(`fixture not ready: ${stderr}`);
					await delay(10);
				}
				row.pi = JSON.parse(readFileSync(ready, "utf8"));
				pid = name === "ownership-disabled" ? undefined : Number(readFileSync(pidFile, "utf8").trim());
				row.descendantPid = pid ?? row.pi.pid;
				row.aliveBefore = name === "ownership-disabled" ? !exited : ownerProcessAlive(pid);
				if (!row.aliveBefore) throw new Error("fixture expired before owner exit");
				if (process.platform !== "win32" && row.pi.uid !== evidence.identity.uid) throw new Error("Pi UID differs from identity probe");
				if (name === "ownership-disabled") {
					row.ownershipDisabled = row.pi.pid === child.pid && row.pi.parent === process.pid && row.pi.owner === null;
					if (!row.ownershipDisabled) throw new Error("opt-out still entered a process owner");
				}
				if (name.startsWith("kill-")) {
					row.termination = process.platform === "win32" ? "SIGTERM (TerminateProcess)" : "SIGTERM";
					child.kill("SIGTERM");
				} else writeFileSync(release, "exit");
				row.exit = await completion;
				row.guardExpired = guardExpired;
				row.aliveAfter = name === "ownership-disabled" ? false : ownerProcessAlive(pid);
				row.immediateChecks = 1;
				row.peerAlive = ownerProcessAlive(peer.pid);
				if (name === "darwin-fast-escape") {
					row.status = "known-limitation";
					row.limitation = "Darwin 25ms sweep can miss setsid + reparent before first snapshot; either outcome is not containment proof";
				} else if (!row.aliveAfter && row.peerAlive && !guardExpired && !row.exit.error && (name.startsWith("kill-") || row.exit.code === 0)) row.status = "passed";
			} catch (error) { row.error = error.message; }
			finally {
				row.peerAlive ??= ownerProcessAlive(peer.pid);
				clearTimeout(guard);
				if (!exited) { child.kill("SIGKILL"); await completion; }
				// Cleanup is after evidence, never a second acceptance lookup or expiry credit.
				if (pid === undefined && existsSync(pidFile)) pid = Number(readFileSync(pidFile, "utf8").trim());
				if (row.aliveAfter !== false && Number.isSafeInteger(pid) && pid > 1) { try { process.kill(pid, "SIGKILL"); } catch {} }
			}
		}
		Object.assign(evidence, artifactBunFromOwnerRows(evidence.rows));
		if (target.os === "windows") evidence.windowsRuntimeGate = smokeWindowsOwnerGate(executable, target, evidence.rows[0]?.pi?.owner, evidence.identity, { work: windowsGateRoot, artifactBunVersion: evidence.artifactBunVersion });
		evidence.status = "passed";
		try {
			assertOwnerLifecycle(evidence, target.os);
			if (target.os === "windows" && evidence.windowsRuntimeGate.status !== "passed") throw new Error(evidence.windowsRuntimeGate.error);
		}
		catch (error) { evidence.status = "failed"; evidence.error = error.message; }
		evidence.elapsedMs = Math.round(performance.now() - started);
		return evidence;
	} finally {
		peer.kill("SIGKILL");
		rmSync(work, { recursive: true, force: true });
	}
}

// Account creation is CI-only. The child probes its own token before spawning any fixtures.
export async function smokeOwnerLifecycleAsNonadmin(executable, target, { platform = process.platform, env = process.env, identityProbe = ownerIdentity, run = spawnSync } = {}) {
	let identity;
	try { identity = identityProbe(); }
	catch (error) { return { status: "failed", identity: null, rows: [], ...artifactBunFromOwnerRows([]), error: `owner identity probe failed: ${error.message}` }; }
	if (!ownerPrivilegeDropRequired(platform, identity, env)) {
		if (platform !== "win32" || env.PI_WINDOWS_GATE_ROOT) return smokeOwnerLifecycle(executable, target, { timeoutMs: target.emulated ? 180_000 : 60_000 });
		const scratch = mkdtempSync(join(tmpdir(), "pi-windows-gate-"));
		try {
			stageWindowsOwnerGate(scratch, { env, run });
			return await smokeOwnerLifecycle(executable, target, { windowsGateRoot: scratch });
		} catch (error) { return { status: "failed", identity, rows: [], ...artifactBunFromOwnerRows([]), error: error.message }; }
		finally { rmSync(scratch, { recursive: true, force: true }); }
	}
	const user = "pi-owner-smoke";
	// A privileged non-root POSIX runner (Darwin admin, Linux sudo/docker) provisions and launches through sudo -n.
	const viaSudo = platform !== "win32" && (platform === "darwin" || identity.uid !== 0);
	const sudo = (file, args) => (viaSudo ? ["sudo", ["-n", file, ...args]] : [file, args]);
	const privilegeDrop = { method: platform === "win32" ? "Start-Process -Credential" : viaSudo ? "sudo -u" : "su -m", user, verifiedNonadmin: false };
	let work;
	let created = false;
	let evidence = { status: "failed", identity: null, rows: [], ...artifactBunFromOwnerRows([]), privilegeDrop };
	// Bounded per-step trail so one CI round exposes every failing layer, not just the first symptom.
	const tail = (value) => (typeof value === "string" ? value.slice(-4096) : value == null ? null : String(value).slice(-4096));
	const steps = [];
	const secrets = [];
	privilegeDrop.diagnostics = { steps };
	const traced = (file, args, options = {}) => {
		const result = run(file, args, { encoding: "utf8", timeout: 120_000, ...options });
		// Passwords appear only in argv of account creation and the launcher command; never record them.
		steps.push({ file, args: args.map((value) => (secrets.some((secret) => value.includes(secret)) ? "<redacted>" : value)), status: result.status ?? null, signal: result.signal ?? null, error: result.error?.message ?? null, stderr: tail(result.stderr) });
		return result;
	};
	const command = (file, args, options = {}) => {
		const result = traced(file, args, options);
		if (result.status !== 0) throw new Error(`${file}: ${result.stderr || result.error?.message || result.status}`);
		return result;
	};
	const ps = (value) => `'${value.replaceAll("'", "''")}'`;
	try {
		// Never reuse or delete a pre-existing account, including on self-hosted CI.
		const lookup = run(platform === "win32" ? "net.exe" : "id", platform === "win32" ? ["user", user] : ["-u", user], { encoding: "utf8", timeout: 10_000 });
		if (lookup.status !== (platform === "win32" ? 2 : 1)) throw new Error(`cannot create dedicated user: account exists or lookup failed (${lookup.status ?? lookup.error?.message})`);
		// Windows: not under %SystemRoot%\Temp, which standard users cannot execute from; a drive-root directory
		// carries only the explicit ACEs granted below.
		if (platform === "win32" && !env.SystemDrive) throw new Error("SystemDrive is not set");
		work = mkdtempSync(join(platform === "win32" ? `${env.SystemDrive}${sep}` : "/tmp", "pi-owner-nonadmin-"));
		// net user otherwise prompts for confirmation for passwords longer than 14 characters.
		const password = `Pi!9${randomBytes(8).toString("base64url").slice(0, 10)}`;
		secrets.push(password);
		if (platform === "freebsd") command(...sudo("pw", ["useradd", user, "-m", "-d", work, "-s", "/bin/sh", "-G", ""]));
		else if (platform === "darwin") command(...sudo("sysadminctl", ["-addUser", user, "-password", password, "-home", work, "-shell", "/bin/sh"]));
		else if (platform === "win32") command("net.exe", ["user", user, password, "/add"]);
		else command(...sudo("sh", ["-c", 'if command -v useradd >/dev/null; then exec useradd -m -d "$1" -s /bin/sh "$2"; else exec adduser -D -h "$1" -s /bin/sh "$2"; fi', "sh", work, user]));
		created = true;
		const runtime = join(work, basename(process.execPath));
		const staged = join(work, target.executable);
		copyFileSync(process.execPath, runtime);
		copyFileSync(executable, staged);
		const scripts = join(work, "scripts");
		mkdirSync(join(scripts, "lib"), { recursive: true });
		copyFileSync(fileURLToPath(import.meta.url), join(scripts, "smoke-owner-lifecycle.mjs"));
		copyFileSync(fileURLToPath(new URL("./lib/bun-targets.mjs", import.meta.url)), join(scripts, "lib", "bun-targets.mjs"));
		copyFileSync(fileURLToPath(new URL("./smoke-windows-owner-gate.mjs", import.meta.url)), join(scripts, "smoke-windows-owner-gate.mjs"));
		copyFileSync(fileURLToPath(new URL("./smoke-unix-owner-pty.mjs", import.meta.url)), join(scripts, "smoke-unix-owner-pty.mjs"));
		if (platform !== "win32") {
			if (!env.PI_OWNER_PTY_HARNESS) throw new Error("PI_OWNER_PTY_HARNESS missing: stage matching CI-only native fixture");
			copyFileSync(env.PI_OWNER_PTY_HARNESS, join(work, "owner-pty"));
			chmodSync(join(work, "owner-pty"), 0o755);
		}
		if (platform === "win32") stageWindowsOwnerGate(work, { env, run: traced });
		cpSync(fileURLToPath(new URL("./fixtures/owner/", import.meta.url)), join(scripts, "fixtures", "owner"), { recursive: true });
		mkdirSync(join(work, "tmp"));
		const childEnv = { PATH: platform === "win32" ? `${work};${env.SystemRoot}\\System32;${env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0` : `${work}:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin`, HOME: work, USERPROFILE: work, USER: user, LOGNAME: user, TMPDIR: join(work, "tmp"), TMP: join(work, "tmp"), TEMP: join(work, "tmp"), CI: "true", PI_OFFLINE: "1" };
		if (platform === "win32") childEnv.PI_WINDOWS_GATE_ROOT = work;
		else childEnv.PI_OWNER_PTY_HARNESS = join(work, "owner-pty");
		privilegeDrop.path = childEnv.PATH;
		const args = [join(scripts, "smoke-owner-lifecycle.mjs"), staged, target.id, join(work, "child-evidence.json")];
		let result;
		const timeout = platform === "win32" ? 1_200_000 : target.emulated ? 1_050_000 : 420_000;
		if (platform === "win32") {
			const account = `${env.COMPUTERNAME}\\${user}`;
			// Protect each directory's own DACL, then reset its contents to inherit it. `/inheritance:r ... /T` would strip
			// files' inherited ACEs while (OI)(CI) grants never apply to files, leaving node.exe with an empty DACL.
			const secure = (directory, access) => {
				command("icacls.exe", [directory, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)${access}`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/Q"]);
				command("icacls.exe", [join(directory, "*"), "/reset", "/T", "/Q"]);
			};
			secure(work, "F");
			for (const directory of ["packages", "node_modules", "scripts"]) secure(join(work, directory), "RX");
			privilegeDrop.diagnostics.acl = ["", "node.exe", "scripts"].map((entry) => tail(run("icacls.exe", [join(work, entry)], { encoding: "utf8", timeout: 30_000 }).stdout));
			const launcher = join(work, "launch.ps1");
			// Preflight each runtime layer as the dropped user, all to stderr, so one CI round reports every blocked layer.
			const preflight = [[`${env.SystemRoot}\\System32\\cmd.exe`, "/d", "/c", "ver"], [runtime, "--version"], [runtime, "--experimental-strip-types", "-e", "0"], ...(existsSync(join(work, "bun.exe")) ? [[join(work, "bun.exe"), "--version"]] : []), [`${env.SystemRoot}\\System32\\whoami.exe`, "/groups"]];
			const probes = preflight.map((probe) => `try { $o = & ${probe.map(ps).join(" ")} 2>&1 | Out-String; [Console]::Error.WriteLine("preflight ${probe.slice(1).join(" ").replaceAll("\"", "")}: exit $LASTEXITCODE $o") } catch { [Console]::Error.WriteLine("preflight ${probe.slice(1).join(" ").replaceAll("\"", "")}: $($_.Exception.Message)") }`).join("\n");
			writeFileSync(launcher, `${Object.entries(childEnv).map(([key, value]) => `$env:${key}=${ps(value)}`).join("\n")}\nRemove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue\n${probes}\n$ErrorActionPreference='Stop'\n& ${[runtime, ...args].map(ps).join(" ")}\nexit $LASTEXITCODE\n`);
			const stdout = join(work, "stdout.txt");
			const stderr = join(work, "stderr.txt");
			result = traced("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; $c=New-Object System.Management.Automation.PSCredential(${ps(account)}, (ConvertTo-SecureString ${ps(password)} -AsPlainText -Force)); $p=Start-Process -FilePath "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Credential $c -LoadUserProfile -WorkingDirectory ${ps(work)} -ArgumentList ${ps(`-NoProfile -NonInteractive -File "${launcher}"`)} -RedirectStandardOutput ${ps(stdout)} -RedirectStandardError ${ps(stderr)} -Wait -PassThru; exit $p.ExitCode`], { encoding: "utf8", timeout, cwd: work });
			if (existsSync(stdout)) result.stdout = readFileSync(stdout, "utf8").replace(/^\uFEFF/, "");
			if (existsSync(stderr)) result.stderr = `${result.stderr ?? ""}${readFileSync(stderr, "utf8")}`;
		} else {
			chmodSync(runtime, 0o755);
			chmodSync(staged, 0o755);
			command(...sudo("chown", ["-R", user, work]));
			const invocation = ["env", "-i", ...Object.entries(childEnv).map(([key, value]) => `${key}=${value}`), runtime, ...args];
			result = viaSudo
				// The non-root runner cannot chdir into scratch once it is chowned 0700 to the dropped user.
				? traced("sudo", ["-n", "-u", user, "-H", ...invocation], { encoding: "utf8", timeout, cwd: "/" })
				: traced("su", ["-m", user, "-c", `exec ${invocation.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ")}`], { encoding: "utf8", timeout, cwd: work });
		}
		privilegeDrop.diagnostics.child = { status: result.status ?? null, signal: result.signal ?? null, error: result.error?.message ?? null, stdout: tail(result.stdout), stderr: tail(result.stderr), script: args[0], scriptRealpath: (() => { try { return realpathSync(args[0]); } catch (error) { return `realpath failed: ${error.message}`; } })() };
		// The child file survives stdout truncation; read it before deleting the dedicated user's scratch.
		try { evidence = { ...JSON.parse(existsSync(args.at(-1)) ? readFileSync(args.at(-1), "utf8") : result.stdout.trim().split(/\r?\n/).at(-1)), privilegeDrop }; }
		catch { throw new Error(`child produced no identity evidence: ${JSON.stringify(privilegeDrop.diagnostics.child)}`); }
		assertNonadminIdentity(evidence.identity, target.os);
		// The dedicated account must be least-privilege, not merely non-root.
		if (evidence.identity.rootEquivalentGroup === true) throw new Error("owner lifecycle missing nonadmin identity: dropped user is in a root-equivalent group");
		privilegeDrop.verifiedNonadmin = true;
		if (result.status !== 0 || evidence.status !== "passed") throw new Error(evidence.error || `child failed (${result.status ?? result.error?.message}): ${result.stderr}`);
		assertOwnerLifecycle(evidence, target.os);
		if (target.os === "windows") assertWindowsOwnerGate(evidence.windowsRuntimeGate, target.id, createHash("sha256").update(readFileSync(executable)).digest("hex"), evidence.identity, evidence.artifactBunVersion);
	} catch (error) {
		evidence.status = "failed";
		evidence.error = `owner privilege drop${privilegeDrop.verifiedNonadmin ? " child" : " identity/setup"} failed: ${error.message}`;
	} finally {
		const warnings = [];
		if (created) {
			try {
				if (platform === "freebsd") command(...sudo("pw", ["userdel", user]));
				else if (platform === "darwin") command(...sudo("sysadminctl", ["-deleteUser", user]));
				else if (platform === "win32") command("net.exe", ["user", user, "/delete"]);
				else command(...sudo("sh", ["-c", 'if command -v userdel >/dev/null; then exec userdel "$1"; else exec deluser "$1"; fi', "sh", user]));
			} catch (error) { warnings.push(`user cleanup: ${error.message}`); }
		}
		if (work) {
			try {
				if (viaSudo) command("sudo", ["-n", "rm", "-rf", work]);
				else rmSync(work, { recursive: true, force: true });
			} catch (error) { warnings.push(`scratch cleanup: ${error.message}`); }
		}
		if (warnings.length) privilegeDrop.cleanupWarnings = warnings;
	}
	return evidence;
}

if (process.argv[1] && isMainModulePath(fileURLToPath(import.meta.url), process.argv[1])) {
	const [executable, targetId, output] = process.argv.slice(2);
	if (!executable || !targetId || !output) throw new Error("Usage: smoke-owner-lifecycle.mjs <staged-pi> <target> <evidence.json>");
	const evidence = await smokeOwnerLifecycleAsNonadmin(resolve(executable), bunTarget(targetId));
	// Parent and dropped child each write their own output path.
	writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
	console.log(JSON.stringify(evidence));
	process.exitCode = evidence.status === "passed" ? 0 : 1;
}
