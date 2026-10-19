#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bunTarget, isMainModulePath } from "./lib/bun-targets.mjs";

function query(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
	if (result.status !== 0) throw new Error(`${command}: ${result.stderr || result.error?.message || result.status}`);
	return result.stdout.trim();
}

export function ownerIdentity() {
	if (process.platform === "win32") {
		const token = JSON.parse(query("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$i=[Security.Principal.WindowsIdentity]::GetCurrent(); $p=New-Object Security.Principal.WindowsPrincipal($i); @{name=$i.Name; elevated=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); groups=@($i.Groups | ForEach-Object {$_.Value})} | ConvertTo-Json -Compress"]));
		const groups = query("whoami.exe", ["/groups", "/fo", "csv"]);
		return { ...token, tokenGroups: groups, adminGroup: token.groups.includes("S-1-5-32-544"), elevated: token.elevated || /S-1-16-(12288|16384)/.test(groups) };
	}
	const identity = { uid: process.getuid(), euid: process.geteuid(), gid: process.getgid(), egid: process.getegid(), groups: process.getgroups(), credentials: query("id", ["-a"]), elevated: process.getuid() === 0 || process.geteuid() === 0 };
	if (process.platform === "linux") {
		identity.capabilities = Object.fromEntries([...readFileSync("/proc/self/status", "utf8").matchAll(/^(Cap\w+):\s*([0-9a-f]+)$/gm)].map((match) => [match[1], match[2]]));
		if (!["CapPrm", "CapEff", "CapAmb"].every((key) => /^[0-9a-f]+$/.test(identity.capabilities[key] ?? ""))) throw new Error("Linux capability evidence missing");
		identity.elevated ||= ["CapPrm", "CapEff", "CapAmb"].some((key) => BigInt(`0x${identity.capabilities[key]}`) !== 0n);
	} else if (process.platform === "freebsd") {
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
		return query("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) {'alive'} else {'gone'}`]) === "alive";
	}
	const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 10_000 });
	if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) return false;
	if (result.status !== 0 || !result.stdout.trim()) throw new Error(`PID lookup failed: ${result.stderr || result.error?.message || result.status}`);
	return !result.stdout.trim().startsWith("Z");
}

export function assertOwnerLifecycle(evidence, os) {
	if (evidence?.status !== "passed" || evidence.identity?.elevated !== false || evidence.identity?.adminGroup === true) throw new Error("owner lifecycle missing nonadmin identity");
	const expected = ["normal-double-fork", "kill-double-fork", "normal-setsid", "kill-setsid", ...(os === "darwin" ? ["darwin-fast-escape"] : [])];
	if (JSON.stringify(evidence.rows?.map(({ name }) => name)) !== JSON.stringify(expected)) throw new Error("owner lifecycle row inventory mismatch");
	for (const row of evidence.rows) {
		if (row.guardExpired === true || row.aliveBefore !== true || row.peerAlive !== true || row.immediateChecks !== 1 || typeof row.aliveAfter !== "boolean") throw new Error(`owner lifecycle invalid observation: ${row.name}`);
		if (row.name === "darwin-fast-escape") {
			if (row.status !== "known-limitation" || !row.limitation) throw new Error("Darwin fast escape must be labeled known-limitation");
		} else if (row.status !== "passed" || row.aliveAfter !== false) throw new Error(`owner lifecycle containment failed: ${row.name}`);
	}
}

export async function smokeOwnerLifecycle(executable, target, { timeoutMs = 60_000 } = {}) {
	const started = performance.now();
	const evidence = { status: "failed", identity: null, rows: [], path: "ownCliProcesses + explicit extension factory; no model, prompt or API", peerPid: null };
	try { evidence.identity = ownerIdentity(); }
	catch (error) { evidence.identity = { elevated: null, error: error.message }; }
	const work = mkdtempSync(join(tmpdir(), "pi-owner-smoke-"));
	const fixtures = fileURLToPath(new URL("./fixtures/owner/", import.meta.url));
	const peer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	const peerStarted = new Promise((resolve, reject) => { peer.once("spawn", resolve); peer.once("error", reject); });
	try {
		await peerStarted;
		evidence.peerPid = peer.pid;
		for (const name of ["normal-double-fork", "kill-double-fork", "normal-setsid", "kill-setsid", ...(target.os === "darwin" ? ["darwin-fast-escape"] : [])]) {
			const pidFile = join(work, `${name}.pid`);
			const ready = join(work, `${name}.ready`);
			const release = join(work, `${name}.release`);
			const row = { name, status: "failed", immediateChecks: 0 };
			evidence.rows.push(row);
			const env = { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: work, HOME: work, USERPROFILE: work, PI_OWNER_RUNTIME: process.execPath, PI_OWNER_FIXTURES: fixtures, PI_OWNER_PID_FILE: pidFile, PI_OWNER_READY: ready, PI_OWNER_RELEASE: release, PI_OWNER_CASE: name === "darwin-fast-escape" ? "fast-escape" : name.endsWith("double-fork") ? "double-fork" : "setsid" };
			for (const key of ["PI_PROCESS_OWNER_PID", "PI_PROCESS_OWNER_PENDING", "PI_PROCESS_OWNER_BINARY", "PI_STARTUP_BENCHMARK"]) delete env[key];
			const child = spawn(executable, ["-p", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", join(fixtures, "extension.mjs")], { cwd: work, env, stdio: ["ignore", "ignore", "pipe"] });
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
				pid = Number(readFileSync(pidFile, "utf8").trim());
				row.descendantPid = pid;
				row.pi = JSON.parse(readFileSync(ready, "utf8"));
				row.aliveBefore = ownerProcessAlive(pid);
				if (!row.aliveBefore) throw new Error("fixture expired before owner exit");
				if (process.platform !== "win32" && row.pi.uid !== evidence.identity.uid) throw new Error("Pi UID differs from identity probe");
				if (name.startsWith("kill-")) {
					row.termination = process.platform === "win32" ? "SIGTERM (TerminateProcess)" : "SIGTERM";
					child.kill("SIGTERM");
				} else writeFileSync(release, "exit");
				row.exit = await completion;
				row.guardExpired = guardExpired;
				row.aliveAfter = ownerProcessAlive(pid);
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
		evidence.status = "passed";
		try { assertOwnerLifecycle(evidence, target.os); }
		catch (error) { evidence.status = "failed"; evidence.error = error.message; }
		evidence.elapsedMs = Math.round(performance.now() - started);
		return evidence;
	} finally {
		peer.kill("SIGKILL");
		rmSync(work, { recursive: true, force: true });
	}
}

if (process.argv[1] && isMainModulePath(fileURLToPath(import.meta.url), process.argv[1])) {
	const [executable, targetId, output] = process.argv.slice(2);
	if (!executable || !targetId || !output) throw new Error("Usage: smoke-owner-lifecycle.mjs <staged-pi> <target> <evidence.json>");
	const target = bunTarget(targetId);
	let privilegeDrop = null;
	if (process.getuid?.() === 0 && target.libc === "musl" && process.env.PI_XZ_EXECUTOR === "pinned-musl-container") {
		try {
			const uid = Number(query("id", ["-u", "nobody"]));
			const gid = Number(query("id", ["-g", "nobody"]));
			if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) throw new Error("invalid nobody identity");
			process.setgroups([]);
			process.setgid(gid);
			process.setuid(uid);
			process.env.TMPDIR = "/tmp";
			privilegeDrop = { method: "runtime setgroups/setgid/setuid to existing nobody", uid, gid };
		} catch (error) { privilegeDrop = { knownGap: `musl nonadmin drop failed: ${error.message}` }; }
	}
	const evidence = await smokeOwnerLifecycle(resolve(executable), target, { timeoutMs: target.emulated ? 180_000 : 60_000 });
	evidence.privilegeDrop = privilegeDrop;
	// Parent owns the output path; stdout also carries evidence after a privilege drop.
	if (privilegeDrop?.uid) console.log(JSON.stringify(evidence));
	else { writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`); console.log(JSON.stringify(evidence)); }
	process.exitCode = evidence.status === "passed" ? 0 : 1;
}
