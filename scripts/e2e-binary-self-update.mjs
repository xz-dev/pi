#!/usr/bin/env node
// Single-executable self-update E2E. Serves release-manifest.json +
// SHA256SUMS + attestation-subjects.jsonl + the `pi-<target>.zip` asset from a local HTTP server, installs
// an older candidate as `pi`, runs `pi update --self` through
// PI_XZ_RELEASE_BASE_URL, and asserts the new version activated with the old
// one retained as a `pi-<old version>` backup. A corrupt asset attempt leaves
// the entrypoint byte-identical; `pi update --clean` removes only the backup.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { bunTarget, releaseArchiveName } from "./lib/bun-targets.mjs";
import { MANIFEST_SCHEMA_VERSION, readReleaseArchive } from "./lib/github-release.mjs";
import { run } from "./lib/e2e-command.mjs";

const [candidateArg, targetId, expectedVersion, oldAssetArg] = process.argv.slice(2);
if (!candidateArg || !targetId || !expectedVersion) {
	throw new Error("Usage: e2e-binary-self-update.mjs <candidate-dir> <target> <version> [old-release-zip]");
}
const candidate = resolve(candidateArg);
const target = bunTarget(targetId);
const assetName = releaseArchiveName(targetId);
const assetPath = join(candidate, assetName);
const work = mkdtempSync(join(tmpdir(), "pi-self-update-e2e-"));
const install = join(work, "install");
const executable = join(install, target.executable);
const exeExt = target.os === "windows" ? ".exe" : "";

// Preserve the signed bytes; parsing and reserializing invalidates the attestation.
const manifestBytes = readFileSync(join(candidate, "release-manifest.json"));
const attestationBytes = readFileSync(join(candidate, "attestation-subjects.jsonl"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
	throw new Error("Release candidate manifest does not match the current audit contract");
}
const bundle = manifest.bundles?.[targetId];
if (bundle?.file !== assetName || bundle.bytes !== statSync(assetPath).size) {
	throw new Error(`Release candidate bundle metadata mismatch for ${targetId}`);
}
const goodBytes = readFileSync(assetPath);
const goodSha256 = createHash("sha256").update(goodBytes).digest("hex");
if (bundle.sha256 !== goodSha256) throw new Error("Candidate asset sha256 does not match the manifest");
const goodExecutable = readReleaseArchive(goodBytes, target.executable, assetName);

// The "old" install is the previous Release's `pi-<target>.zip`: its embedded
// updater is the one users actually run, so this proves the published update
// path works across releases.
const oldPath = oldAssetArg ? resolve(oldAssetArg) : join(candidate, "old", assetName);
const oldBytes = existsSync(oldPath) ? readReleaseArchive(readFileSync(oldPath), target.executable, oldPath) : undefined;
if (!oldBytes && process.env.PI_XZ_E2E_ALLOW_NO_OLD !== "1") {
	throw new Error(`Old-version executable is required for E2E: ${oldPath} missing`);
}

let served = {
	bytes: goodBytes,
	manifest: manifestBytes,
	attestations: attestationBytes,
};
const manifestPayload = () => served.manifest;

let releaseBase;
const server = createServer((request, response) => {
	try {
		const name = basename(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
		if (name === "attestation-subjects.jsonl") {
			if (served.attestations === null) response.writeHead(404).end();
			else response.writeHead(200, { "content-type": "application/x-ndjson" }).end(served.attestations);
			return;
		}
		if (name === "release-manifest.json") {
			const body = manifestPayload();
			response.writeHead(200, { "content-type": "application/json", "content-length": body.byteLength });
			response.end(body);
			return;
		}
		if (name === "SHA256SUMS") {
			const body = `${createHash("sha256").update(manifestPayload()).digest("hex")}  release-manifest.json\n`;
			response.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) });
			response.end(body);
			return;
		}
		if (name === assetName) {
			response.writeHead(200, { connection: "close", "content-length": served.bytes.byteLength });
			response.end(served.bytes);
			return;
		}
		response.writeHead(404).end();
	} catch (error) {
		response.writeHead(500).end(String(error));
	}
});

function probe(path, args, env) {
	const result = spawnSync(path, args, { env, encoding: "utf8", timeout: 60_000 });
	if (result.status !== 0) {
		throw new Error(`${path} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	}
	return (result.stdout ?? "").trim();
}

let runError;
try {
	mkdirSync(install, { recursive: true });
	mkdirSync(join(work, "home"), { recursive: true });
	mkdirSync(join(work, "agent"), { recursive: true });
	writeFileSync(executable, goodExecutable);
	if (target.os !== "windows") chmodSync(executable, 0o755);

	await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Could not bind local Release server");
	releaseBase = `http://127.0.0.1:${address.port}/`;
	const env = {
		...process.env,
		HOME: join(work, "home"),
		USERPROFILE: join(work, "home"),
		PI_CODING_AGENT_DIR: join(work, "agent"),
		PI_XZ_RELEASE_BASE_URL: releaseBase,
	};

	// Exercise the NEW client's real verifier even during the transition from unsigned clients.
	// A local mirror serves the genuine signed candidate; no custom trust root or bypass is used.
	const mirrorEnv = { ...env, PI_XZ_RELEASE_BASE_URL: "" };
	const forcedUpdate = ["update", "--self", "--force", "--mirror-url", releaseBase.slice(0, -1)];
	if (manifest.distributionVersion !== expectedVersion || probe(executable, ["--version"], env) !== expectedVersion) {
		throw new Error("Forced-reinstall acceptance requires matching installed and candidate versions");
	}
	const installedInode = statSync(executable).ino;
	await run(executable, forcedUpdate, mirrorEnv);
	if (!readFileSync(executable).equals(goodExecutable)) throw new Error("signed candidate reinstall changed executable bytes");
	const reinstallBackup = join(install, `pi-${expectedVersion}${exeExt}`);
	if (!existsSync(reinstallBackup) || !readFileSync(reinstallBackup).equals(goodExecutable)) {
		throw new Error("Same-version forced reinstall did not retain the installed executable as backup");
	}
	if (target.os !== "windows" && (statSync(executable).ino === installedInode || statSync(reinstallBackup).ino !== installedInode)) {
		throw new Error("Same-version forced reinstall did not activate a distinct verified file");
	}
	await run(executable, ["update", "--clean"], env);
	if (readdirSync(install).length !== 1 || !existsSync(executable)) {
		throw new Error("Same-version forced reinstall left backup or staging residue after cleanup");
	}
	const goodServed = served;
	for (const [label, change] of [
		["missing proof", { attestations: null }],
		["forged proof", { attestations: Buffer.from("{}") }],
		["rewritten manifest and checksums", { manifest: Buffer.concat([manifestBytes, Buffer.from("\n")]) }],
	]) {
		served = { ...goodServed, ...change };
		const error = await run(executable, forcedUpdate, mirrorEnv).then(() => undefined, (failure) => failure);
		if (!(error instanceof Error)) throw new Error(`${label} unexpectedly activated with --force`);
		if (!/attestation|HTTP 404/i.test(error.message)) throw new Error(`${label} failed for the wrong reason: ${error.message}`);
		if (!readFileSync(executable).equals(goodExecutable)) throw new Error(`${label} replaced the running executable`);
		if (readdirSync(install).some((name) => name.endsWith(".download"))) throw new Error(`${label} left a staging file`);
	}
	served = goodServed;
	console.log(`Signed mirror verification E2E passed: ${targetId} ${expectedVersion}`);

	if (!oldBytes) {
		// First ZIP release can skip only the cross-release leg, never the new verifier checks.
		console.log(`Cross-release update skipped: no previous executable for ${targetId}`);
	} else {
		writeFileSync(executable, oldBytes);
		const oldVersion = probe(executable, ["--version"], env);
		if (!/^\d+\.\d+\.\d+-xz\.\d+\.\d+\.g[0-9a-f]{8}$/.test(oldVersion)) {
			throw new Error(`Old executable --version returned unexpected output: ${JSON.stringify(oldVersion)}`);
		}
		if (oldVersion === expectedVersion) throw new Error("Old and new candidates must differ");
		console.log(`Installed ${targetId} ${oldVersion}; candidate ${expectedVersion}`);

		// Corrupt-asset attempt: the manifest still advertises the genuine sha256,
		// so mismatched served bytes must be rejected before activation.
		const corrupt = Buffer.alloc(goodBytes.byteLength, 7);
		served = { ...served, bytes: corrupt };
		const corruptError = await run(executable, ["update", "--self"], env).then(
			() => undefined,
			(error) => error,
		);
		if (!(corruptError instanceof Error)) throw new Error("corrupt asset unexpectedly activated");
		if (!readFileSync(executable).equals(oldBytes)) throw new Error("corrupt update replaced the running executable");
		console.log(`Corrupt asset rejected: ${String(corruptError.message).split("\n")[0]}`);

		served = { ...served, bytes: goodBytes };
		console.log(`Updating from local Release: ${targetId} ${expectedVersion}`);
		await run(executable, ["update", "--self"], env);

		if (!readFileSync(executable).equals(goodExecutable)) throw new Error("updated executable is not the ZIP's executable");
		const updatedVersion = probe(executable, ["--version"], env);
		if (updatedVersion !== expectedVersion) {
			throw new Error(`Updated executable reported ${JSON.stringify(updatedVersion)}, expected ${expectedVersion}`);
		}
		const backup = join(install, `pi-${oldVersion}${exeExt}`);
		if (!existsSync(backup)) throw new Error(`Versioned backup missing: ${backup}`);
		if (probe(backup, ["--version"], env) !== oldVersion) {
			throw new Error("Versioned backup does not run the old version");
		}
		// update --clean removes strict version backups only.
		writeFileSync(join(install, "pi-foo"), "keep\n");
		await run(executable, ["update", "--clean"], env);
		if (existsSync(backup)) throw new Error("update --clean did not remove the versioned backup");
		if (!existsSync(join(install, "pi-foo"))) throw new Error("update --clean removed a non-versioned file");
		if (probe(executable, ["--version"], env) !== expectedVersion) {
			throw new Error("update --clean left the entrypoint in an unexpected state");
		}
		const staleBackup = join(install, `pi-0.0.0-xz.0.1.gffffffff${exeExt}`);
		writeFileSync(staleBackup, "stale\n");
		await run(executable, ["update", "--clean"], env);
		if (existsSync(staleBackup)) throw new Error("update --clean did not remove the strict-version backup");
		if (!existsSync(executable)) throw new Error("update --clean removed the running executable");
		console.log(`Self-update E2E passed: ${targetId} ${oldVersion} -> ${expectedVersion}`);
	}
} catch (error) {
	runError = error;
	throw error;
} finally {
	await new Promise((resolveClose) => server.close(resolveClose));
	try {
		rmSync(work, { recursive: true, force: true, maxRetries: 60, retryDelay: 500 });
	} catch (error) {
		if (!runError) throw error;
		console.error(`Self-update E2E cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
