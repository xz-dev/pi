#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { binaryArchiveName, bunTarget } from "./lib/bun-targets.mjs";

const [candidateArg, targetId, expectedVersion] = process.argv.slice(2);
if (!candidateArg || !targetId || !expectedVersion) {
	throw new Error("Usage: e2e-binary-self-update.mjs <candidate-dir> <target> <version>");
}
const candidate = resolve(candidateArg);
const target = bunTarget(targetId);
const archive = join(candidate, binaryArchiveName(targetId));
const work = mkdtempSync(join(tmpdir(), "pi self-update e2e-"));
const install = join(work, "install");
const wrapper = join(install, target.wrapper);
const executable = join(install, target.executable);

function run(command, args, env = process.env) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { env, windowsHide: true });
		child.stdin.end();
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			if (process.platform === "win32" && child.pid) {
				const taskkill = join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", "taskkill.exe");
				spawnSync(taskkill, ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
			} else {
				child.kill("SIGKILL");
			}
			const currentPath = join(install, "current");
			const current = existsSync(currentPath) ? readFileSync(currentPath, "utf8").trim() : "missing";
			reject(new Error(`${command} ${args.join(" ")} timed out (current=${current}): ${stdout}${stderr}`));
		}, 120_000);
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", (error) => {
			clearTimeout(timer);
			settled = true;
			reject(error);
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			clearTimeout(timer);
			settled = true;
			if (code === 0) resolveRun(stdout);
			else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code}): ${stdout}${stderr}`));
		});
	});
}

const server = createServer((request, response) => {
	try {
		const name = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.slice(1));
		if (!name || basename(name) !== name) {
			response.writeHead(404).end();
			return;
		}
		const path = join(candidate, name);
		if (!existsSync(path)) {
			response.writeHead(404).end();
			return;
		}
		console.log(`Serving ${name}`);
		response.once("finish", () => console.log(`Served ${name}`));
		response.writeHead(200, { "connection": "close", "content-length": statSync(path).size });
		createReadStream(path).pipe(response);
	} catch (error) {
		response.writeHead(500).end(String(error));
	}
});

let runError;
try {
	mkdirSync(install);
	const windowsTar = join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", "tar.exe");
	const extraction = spawnSync(
		target.os === "windows" ? windowsTar : "unzip",
		target.os === "windows" ? ["-xf", archive, "-C", install] : ["-q", archive, "-d", install],
		{ encoding: "utf8" },
	);
	if (extraction.status !== 0) throw new Error(`Could not extract ${archive}: ${extraction.stderr || extraction.stdout}`);

	const packagePath = join(install, "package.json");
	const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
	const version = /^(\d+\.\d+\.\d+)-xz\./.exec(expectedVersion);
	if (!version) throw new Error(`Invalid expected xz-dev version: ${expectedVersion}`);
	const oldVersion = `${version[1]}-xz.0.1.g00000000`;
	packageJson.version = oldVersion;
	writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
	const wrapperSha256 = createHash("sha256").update(readFileSync(wrapper)).digest("hex");
	const wrapperInode = statSync(wrapper).ino;
	const offlineEnv = { ...process.env, PI_CODING_AGENT_DIR: join(work, "agent"), PI_OFFLINE: "1" };
	console.log(`Starting old bundle: ${targetId} ${oldVersion}`);
	if ((await run(wrapper, ["--version"], offlineEnv)).trim() !== oldVersion) throw new Error("Old direct bundle did not start");

	await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Could not bind local Release server");
	console.log(`Updating from local Release: ${targetId} ${expectedVersion}`);
	await run(executable, ["update", "--self"], {
		...process.env,
		PI_CODING_AGENT_DIR: join(work, "agent"),
		PI_XZ_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}/`,
	});

	const current = readFileSync(join(install, "current"), "utf8").trim();
	if (current !== expectedVersion) throw new Error(`current points to ${current}, expected ${expectedVersion}`);
	const activatedBundle = join(install, "bundles", expectedVersion);
	if (!existsSync(join(activatedBundle, target.wrapper)) || !existsSync(join(activatedBundle, target.executable))) {
		throw new Error("Activated bundle is missing wrapper or pi-native");
	}
	if (target.os !== "windows" && statSync(wrapper).ino === wrapperInode) {
		throw new Error("POSIX root wrapper was not atomically replaced");
	}
	rmSync(join(install, target.executable), { force: true });
	console.log(`Starting activated bundle: ${targetId} ${expectedVersion}`);
	if ((await run(wrapper, ["--version"], offlineEnv)).trim() !== expectedVersion) {
		throw new Error("Updated wrapper did not start the activated bundle");
	}
	console.log(`Reapplying from managed bundle: ${targetId} ${expectedVersion}`);
	await run(wrapper, ["update", "--self", "--force"], {
		...process.env,
		PI_CODING_AGENT_DIR: join(work, "agent"),
		PI_XZ_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}/`,
	});
	if ((await run(wrapper, ["--version"], offlineEnv)).trim() !== expectedVersion) {
		throw new Error("Managed bundle did not survive a forced update");
	}
	if (createHash("sha256").update(readFileSync(wrapper)).digest("hex") !== wrapperSha256) {
		throw new Error("Root wrapper identity changed unexpectedly");
	}
	console.log(`Self-update E2E passed: ${targetId} ${oldVersion} -> ${expectedVersion}`);
} catch (error) {
	runError = error;
	throw error;
} finally {
	await new Promise((resolveClose) => server.close(resolveClose));
	try {
		rmSync(work, { recursive: true, force: true });
	} catch (error) {
		if (!runError) throw error;
		console.error(`Self-update E2E cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
