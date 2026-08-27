#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { binaryArchiveName, bunTarget } from "./lib/bun-targets.mjs";
import { BUNDLE_LAYOUT_VERSION, MANIFEST_SCHEMA_VERSION } from "./lib/github-release.mjs";

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

const manifest = JSON.parse(readFileSync(join(candidate, "release-manifest.json"), "utf8"));
if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION || manifest.layoutVersion !== BUNDLE_LAYOUT_VERSION) {
	throw new Error("Release candidate manifest does not match the current audit contract");
}
const bundle = manifest.bundles?.[targetId];
if (bundle?.file !== binaryArchiveName(targetId) || bundle.bytes !== statSync(archive).size) {
	throw new Error(`Release candidate bundle metadata mismatch for ${targetId}`);
}

function fileEvidence(path) {
	return {
		path,
		bytes: statSync(path).size,
		sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
	};
}

function runChecked(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	}
}

function createWindowsBundleVariant(label, mutateHelper) {
	const root = join(work, `variant-${label}`);
	const output = join(work, `${label}.zip`);
	mkdirSync(root);
	runChecked(join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", "tar.exe"), [
		"-xf",
		archive,
		"-C",
		root,
	]);
	mutateHelper(join(root, target.filesystemHelperDir, target.filesystemHelperFile));
	runChecked("7z", ["a", "-bd", "-tzip", "-mm=Deflate", output, "."], { cwd: root });
	runChecked(process.execPath, [join(process.cwd(), "scripts", "normalize-windows-zip.mjs"), output]);
	return output;
}

let servedBundle = fileEvidence(archive);
const releaseManifestBytes = () => {
	const value = {
		...manifest,
		bundles: {
			...manifest.bundles,
			[targetId]: {
				...bundle,
				bytes: servedBundle.bytes,
				sha256: servedBundle.sha256,
			},
		},
	};
	return Buffer.from(JSON.stringify(value));
};

let releaseBase;
const server = createServer((request, response) => {
	try {
		const name = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.slice(1));
		if (name === "latest-release.json") {
			const metadata = JSON.stringify({
				tag_name: manifest.tag,
				target_commitish: manifest.commit,
				draft: false,
				prerelease: false,
				assets: [
					{
						name: bundle.file,
						browser_download_url: `${releaseBase}${bundle.file}`,
						size: servedBundle.bytes,
						digest: `sha256:${servedBundle.sha256}`,
					},
				],
			});
			response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(metadata) });
			response.end(metadata);
			return;
		}
		if (name === "release-manifest.json") {
			const metadata = releaseManifestBytes();
			response.writeHead(200, { "content-type": "application/json", "content-length": metadata.byteLength });
			response.end(metadata);
			return;
		}
		if (name === "SHA256SUMS") {
			const metadata = releaseManifestBytes();
			const sums = `${createHash("sha256").update(metadata).digest("hex")}  release-manifest.json\n`;
			response.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(sums) });
			response.end(sums);
			return;
		}
		if (!name || basename(name) !== name) {
			response.writeHead(404).end();
			return;
		}
		const path = name === bundle.file ? servedBundle.path : join(candidate, name);
		if (!existsSync(path)) {
			response.writeHead(404).end();
			return;
		}
		console.log(`Serving ${name}`);
		response.once("finish", () => console.log(`Served ${name}`));
		response.writeHead(200, { connection: "close", "content-length": statSync(path).size });
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
	releaseBase = `http://127.0.0.1:${address.port}/`;
	if (target.os === "windows") {
		const oppositeHelper = process.env.PI_WIN32_SNAPSHOT_OPPOSITE_HELPER;
		const apiMismatchHelper = process.env.PI_WIN32_SNAPSHOT_API_MISMATCH_HELPER;
		const malformedResultHelper = process.env.PI_WIN32_SNAPSHOT_MALFORMED_RESULT_HELPER;
		if (!oppositeHelper || !apiMismatchHelper || !malformedResultHelper) {
			throw new Error(
				"Windows self-update E2E requires opposite-architecture, API-mismatch, and malformed-result helpers",
			);
		}
		const variants = [
			[
				"missing-helper",
				(path) => rmSync(path),
			],
			[
				"corrupt-helper",
				(path) => writeFileSync(path, "corrupt helper\n"),
			],
			[
				"opposite-architecture-helper",
				(path) => copyFileSync(oppositeHelper, path),
			],
			[
				"malformed-result-helper",
				(path) => copyFileSync(malformedResultHelper, path),
			],
			[
				"api-mismatch-helper",
				(path) => copyFileSync(apiMismatchHelper, path),
			],
		];
		let rejectedDestinationArchive;
		for (const [label, mutate] of variants) {
			const variantArchive = createWindowsBundleVariant(label, mutate);
			servedBundle = fileEvidence(variantArchive);
			if (label === "malformed-result-helper") rejectedDestinationArchive = variantArchive;
			console.log(`Rejecting ${label}: ${targetId} ${expectedVersion}`);
			const error = await run(executable, ["update", "--self"], {
				...process.env,
				PI_CODING_AGENT_DIR: join(work, "agent"),
				PI_XZ_LATEST_RELEASE_URL: `${releaseBase}latest-release.json`,
				PI_XZ_RELEASE_BASE_URL: releaseBase,
			}).then(
				() => undefined,
				(error) => error,
			);
			if (!(error instanceof Error)) throw new Error(`${label} unexpectedly activated`);
			if (existsSync(join(install, "current")) || existsSync(join(install, "previous"))) {
				throw new Error(`${label} published an activation pointer`);
			}
			const rejectedDestination = join(install, "bundles", expectedVersion);
			if (existsSync(rejectedDestination)) {
				throw new Error(`${label} escaped the isolated helper probe into a destination bundle`);
			}
		}
		if (!rejectedDestinationArchive) throw new Error("Windows update matrix produced no rejected destination fixture");
		const rejectedDestination = join(install, "bundles", expectedVersion);
		mkdirSync(rejectedDestination, { recursive: true });
		runChecked(join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", "tar.exe"), [
			"-xf",
			rejectedDestinationArchive,
			"-C",
			rejectedDestination,
		]);
		servedBundle = fileEvidence(archive);
	}
	console.log(`Updating from local Release: ${targetId} ${expectedVersion}`);
	await run(executable, ["update", "--self"], {
		...process.env,
		PI_CODING_AGENT_DIR: join(work, "agent"),
		PI_XZ_LATEST_RELEASE_URL: `${releaseBase}latest-release.json`,
		PI_XZ_RELEASE_BASE_URL: releaseBase,
	});

	const current = readFileSync(join(install, "current"), "utf8").trim();
	if (current !== expectedVersion) throw new Error(`current points to ${current}, expected ${expectedVersion}`);
	if (existsSync(join(install, "previous"))) throw new Error("First flat-to-managed update published previous");
	if (existsSync(join(install, "bundles", oldVersion))) throw new Error("First update created an unvalidated legacy bundle");
	const activatedBundle = join(install, "bundles", expectedVersion);
	if (!existsSync(join(activatedBundle, target.wrapper)) || !existsSync(join(activatedBundle, target.executable))) {
		throw new Error("Activated bundle is missing wrapper or pi-native");
	}
	if (target.os === "windows") {
		if (
			!readdirSync(join(install, "bundles"), { withFileTypes: true }).some(
				(entry) => entry.isDirectory() && entry.name.startsWith(".update-rejected-"),
			)
		) {
			throw new Error("Windows update retry retained no quarantined rejected bundle");
		}
		const helper = join(activatedBundle, target.filesystemHelperDir, target.filesystemHelperFile);
		if (!existsSync(helper)) throw new Error("Activated Windows bundle is missing filesystem snapshot helper");
	}
	if (target.os !== "windows" && statSync(wrapper).ino === wrapperInode) {
		throw new Error("POSIX root wrapper was not atomically replaced");
	}
	rmSync(join(install, target.executable), { force: true });
	console.log(`Starting activated bundle: ${targetId} ${expectedVersion}`);
	if ((await run(wrapper, ["--version"], offlineEnv)).trim() !== expectedVersion) {
		throw new Error("Updated wrapper did not start the activated bundle");
	}

	const managedPreviousVersion = `${version[1]}-xz.0.2.g11111111`;
	const managedPreviousBundle = join(install, "bundles", managedPreviousVersion);
	renameSync(activatedBundle, managedPreviousBundle);
	const managedPreviousPackagePath = join(managedPreviousBundle, "package.json");
	const managedPreviousPackage = JSON.parse(readFileSync(managedPreviousPackagePath, "utf8"));
	managedPreviousPackage.version = managedPreviousVersion;
	writeFileSync(managedPreviousPackagePath, `${JSON.stringify(managedPreviousPackage, null, 2)}\n`);
	writeFileSync(join(install, "current"), `${managedPreviousVersion}\n`);
	if ((await run(wrapper, ["--version"], offlineEnv)).trim() !== managedPreviousVersion) {
		throw new Error("Managed previous bundle did not start through the wrapper");
	}

	console.log(`Updating managed bundle: ${targetId} ${managedPreviousVersion} -> ${expectedVersion}`);
	await run(wrapper, ["update", "--self", "--force"], {
		...process.env,
		PI_CODING_AGENT_DIR: join(work, "agent"),
		PI_XZ_LATEST_RELEASE_URL: `${releaseBase}latest-release.json`,
		PI_XZ_RELEASE_BASE_URL: releaseBase,
	});
	if (readFileSync(join(install, "current"), "utf8").trim() !== expectedVersion) {
		throw new Error("Managed update did not publish current");
	}
	if (readFileSync(join(install, "previous"), "utf8").trim() !== managedPreviousVersion) {
		throw new Error("Managed update did not publish its validated previous bundle");
	}
	if (target.os === "windows") {
		rmSync(join(managedPreviousBundle, target.filesystemHelperDir, target.filesystemHelperFile));
	}
	if ((await run(wrapper, ["--version"], offlineEnv)).trim() !== expectedVersion) {
		throw new Error("Managed update did not start the activated bundle");
	}

	const staleVersion = `${version[1]}-xz.0.0.gffffffff`;
	const staleBundle = join(install, "bundles", staleVersion);
	mkdirSync(staleBundle);
	for (const required of [target.wrapper, target.executable]) {
		writeFileSync(join(staleBundle, required), `stale ${required}\n`);
	}
	const stalePackage = { ...packageJson, version: staleVersion };
	writeFileSync(join(staleBundle, "package.json"), `${JSON.stringify(stalePackage, null, 2)}\n`);
	console.log(`Cleaning stale bundle: ${targetId} ${staleVersion}`);
	const cleanOutput = await run(wrapper, ["update", "--clean"], offlineEnv);
	if (!cleanOutput.includes("Removed 1 old bundle")) throw new Error(`Cleanup output was not recognized: ${cleanOutput}`);
	if (existsSync(staleBundle)) throw new Error("Stale bundle survived update --clean");
	if (!existsSync(activatedBundle) || !existsSync(managedPreviousBundle)) {
		throw new Error("Cleanup removed a protected bundle");
	}
	if (readFileSync(join(install, "current"), "utf8").trim() !== expectedVersion) {
		throw new Error("Cleanup changed the current pointer");
	}
	if (readFileSync(join(install, "previous"), "utf8").trim() !== managedPreviousVersion) {
		throw new Error("Cleanup changed the previous pointer");
	}
	console.log(`Reapplying from managed bundle: ${targetId} ${expectedVersion}`);
	await run(wrapper, ["update", "--self", "--force"], {
		...process.env,
		PI_CODING_AGENT_DIR: join(work, "agent"),
		PI_XZ_LATEST_RELEASE_URL: `${releaseBase}latest-release.json`,
		PI_XZ_RELEASE_BASE_URL: releaseBase,
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
		rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	} catch (error) {
		if (!runError) throw error;
		console.error(`Self-update E2E cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
