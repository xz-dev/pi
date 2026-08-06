#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	ATTESTATION_SIGNER_REF,
	ATTESTATION_SIGNER_WORKFLOW,
	ATTESTATION_SUBJECTS_FILENAME,
	BINARY_PLATFORMS,
	BUNDLE_LAYOUT_VERSION,
	ENTRY_PACKAGE,
	MANIFEST_SCHEMA_VERSION,
	PACKAGING_BINARY,
	REPOSITORY,
	assertBinaryBundleInventory,
	binaryArchiveName,
	binaryRequiredPaths,
	platformNativeInfo,
	readBundlePackageJson,
	readJson,
	run,
	sha256File,
} from "./lib/github-release.mjs";

const INSTALL_SH_FILENAME = "install.sh";
const INSTALL_PS1_FILENAME = "install.ps1";
const MANIFEST_FILENAME = "release-manifest.json";
const SUMS_FILENAME = "SHA256SUMS";
const ACCEPTANCE_FILENAME = "binary-acceptance.json";

function parseArgs(argv) {
	const [mode, manifestPath, ...extra] = argv.slice(2);
	if (!manifestPath || extra.length || !["local", "all"].includes(mode)) {
		throw new Error("Usage: node scripts/verify-github-release.mjs <local|all> <release-manifest.json>");
	}
	return { mode, manifestPath: resolve(manifestPath) };
}

function assertManifest(manifest, requireFullSet) {
	const allowedKeys = new Set(["schemaVersion", "repository", "tag", "distributionVersion", "apiVersion", "commit", "packaging", "layoutVersion", "bundles", "requiredPaths", "installer", "acceptance", "attestation"]);
	if (!manifest || typeof manifest !== "object" || Object.keys(manifest).some((key) => !allowedKeys.has(key))) throw new Error("Invalid GitHub Release manifest schema");
	const version = /^(\d+\.\d+\.\d+)-xz\.(\d+)\.(\d+)\.g([0-9a-f]{8})$/.exec(manifest.distributionVersion ?? "");
	if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION || manifest.repository !== REPOSITORY || manifest.packaging !== PACKAGING_BINARY || manifest.layoutVersion !== BUNDLE_LAYOUT_VERSION || !version || manifest.apiVersion !== version[1] || manifest.tag !== `xz-v${manifest.distributionVersion}` || !/^[0-9a-f]{40}$/.test(manifest.commit) || !manifest.commit.startsWith(version[4])) throw new Error("Invalid GitHub Release manifest");
	const platforms = Object.keys(manifest.bundles ?? {}).sort();
	if (requireFullSet && JSON.stringify(platforms) !== JSON.stringify([...BINARY_PLATFORMS].sort())) throw new Error(`Manifest bundles must cover exactly the ${BINARY_PLATFORMS.length} canonical Bun targets`);
	for (const platform of platforms) {
		if (!BINARY_PLATFORMS.includes(platform)) throw new Error(`Unexpected bundle platform ${platform}`);
		const bundle = manifest.bundles[platform];
		if (!bundle || bundle.file !== binaryArchiveName(platform) || !Number.isSafeInteger(bundle.bytes) || bundle.bytes <= 0 || !/^[0-9a-f]{64}$/.test(bundle.sha256)) throw new Error(`Invalid bundle metadata for ${platform}`);
		if (!Array.isArray(manifest.requiredPaths?.[platform]) || JSON.stringify([...manifest.requiredPaths[platform]].sort()) !== JSON.stringify(binaryRequiredPaths(platform).sort())) throw new Error(`Manifest requiredPaths for ${platform} does not match canonical inventory`);
	}
	if (manifest.installer?.posix?.file !== INSTALL_SH_FILENAME || manifest.installer?.windows?.file !== INSTALL_PS1_FILENAME || manifest.installer?.checksums?.file !== SUMS_FILENAME || manifest.installer?.checksums?.algorithm !== "sha256") throw new Error("Invalid installer metadata");
	if (manifest.acceptance?.file !== ACCEPTANCE_FILENAME || manifest.acceptance?.targetCount !== BINARY_PLATFORMS.length) throw new Error("Invalid binary acceptance metadata");
	if (manifest.attestation?.repository !== REPOSITORY || manifest.attestation.signerWorkflow !== `${REPOSITORY}/${ATTESTATION_SIGNER_WORKFLOW}` || manifest.attestation.signerRef !== ATTESTATION_SIGNER_REF || manifest.attestation.denySelfHostedRunners !== true || manifest.attestation.subjectsFile !== ATTESTATION_SUBJECTS_FILENAME) throw new Error("Invalid attestation policy");
	return manifest;
}

function parseSums(text) {
	const result = new Map();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]*)$/.exec(line);
		if (!match || result.has(match[2])) throw new Error(`Invalid SHA256SUMS line: ${line}`);
		result.set(match[2], match[1]);
	}
	return result;
}

function assertAsset(releaseDir, sums, file, expectedSha) {
	const path = join(releaseDir, file);
	if (!existsSync(path) || basename(path) !== file) throw new Error(`Missing release asset: ${file}`);
	const actual = sha256File(path);
	if (expectedSha && actual !== expectedSha) throw new Error(`${file} sha256 mismatch`);
	if (sums.get(file) !== actual) throw new Error(`SHA256SUMS digest for ${file} does not match file`);
	return path;
}

function hostPlatform() {
	const override = process.env.PI_XZ_VERIFY_TARGET;
	if (override) {
		if (!BINARY_PLATFORMS.includes(override)) throw new Error(`Invalid PI_XZ_VERIFY_TARGET ${override}`);
		return override;
	}
	const modern = process.arch === "x64" && process.features?.typescript !== undefined && process.env.PI_XZ_VERIFY_MODERN === "1";
	if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : `darwin-x64-${modern ? "modern" : "baseline"}`;
	if (process.platform === "linux") {
		const libc = process.report?.getReport()?.header?.glibcVersionRuntime ? "gnu" : "musl";
		return process.arch === "arm64" ? `linux-arm64-${libc}` : `linux-x64-${libc}-${modern ? "modern" : "baseline"}`;
	}
	if (process.platform === "win32") return process.arch === "arm64" ? "windows-arm64" : `windows-x64-${modern ? "modern" : "baseline"}`;
	return undefined;
}

function readArchivedNotice(archive, platform) {
	const work = mkdtempSync(join(tmpdir(), "pi-release-notice-"));
	try {
		if (platform.startsWith("windows-")) run("unzip", ["-q", archive, "THIRD_PARTY_NOTICES.md", "-d", work]);
		else run("tar", ["-xzf", archive, "-C", work, "pi/THIRD_PARTY_NOTICES.md"]);
		const path = platform.startsWith("windows-") ? join(work, "THIRD_PARTY_NOTICES.md") : join(work, "pi", "THIRD_PARTY_NOTICES.md");
		return { sha256: sha256File(path), bytes: statSync(path).size };
	} finally { rmSync(work, { recursive: true, force: true }); }
}

function smokeHostBundle(archive, platform, version) {
	const work = mkdtempSync(join(tmpdir(), "pi-release-smoke-"));
	try {
		if (platform.startsWith("windows-")) run("unzip", ["-q", archive, "-d", work]);
		else run("tar", ["-xzf", archive, "-C", work]);
		const root = platform.startsWith("windows-") ? work : join(work, "pi");
		const executable = join(root, platform.startsWith("windows-") ? "pi.exe" : "pi");
		const env = { ...process.env, PI_CODING_AGENT_DIR: join(work, "agent") };
		for (const args of [["--version"], ["--help"]]) {
			const result = spawnSync(executable, args, { encoding: "utf8", env });
			if (result.status !== 0) throw new Error(`Host smoke failed: ${result.stdout ?? ""}${result.stderr ?? ""}`);
			if (args[0] === "--version" && (result.stdout ?? "").trim() !== version) throw new Error("Bundle version smoke mismatch");
		}
		console.log(`Host-native bundle smoke ok: ${version}`);
	} finally { rmSync(work, { recursive: true, force: true }); }
}

const { mode, manifestPath } = parseArgs(process.argv);
const releaseDir = dirname(manifestPath);
const manifest = assertManifest(readJson(manifestPath), mode === "all");
const sums = parseSums(readFileSync(join(releaseDir, SUMS_FILENAME), "utf8"));
const assets = [...Object.values(manifest.bundles).map((bundle) => bundle.file), MANIFEST_FILENAME, INSTALL_SH_FILENAME, INSTALL_PS1_FILENAME, ACCEPTANCE_FILENAME, SUMS_FILENAME];
for (const [platform, bundle] of Object.entries(manifest.bundles)) {
	const archive = assertAsset(releaseDir, sums, bundle.file, bundle.sha256);
	if (readFileSync(archive).byteLength !== bundle.bytes) throw new Error(`${bundle.file} byte length mismatch`);
	assertBinaryBundleInventory(archive, platform);
	const packageJson = readBundlePackageJson(archive, platform);
	if (packageJson.name !== ENTRY_PACKAGE || packageJson.version !== manifest.distributionVersion || packageJson.piConfig?.distribution !== "xz-dev") throw new Error(`${bundle.file} package identity mismatch`);
}
for (const file of [MANIFEST_FILENAME, INSTALL_SH_FILENAME, INSTALL_PS1_FILENAME, ACCEPTANCE_FILENAME]) assertAsset(releaseDir, sums, file);
const acceptance = readJson(join(releaseDir, ACCEPTANCE_FILENAME));
if (acceptance.schemaVersion !== 1 || acceptance.targetCount !== BINARY_PLATFORMS.length || acceptance.manifest?.sha256 !== sha256File(manifestPath) || acceptance.manifest?.commit !== manifest.commit || !Array.isArray(acceptance.targets) || acceptance.targets.length !== BINARY_PLATFORMS.length) throw new Error("Invalid binary acceptance record");
for (const record of acceptance.targets) {
	const bundle = manifest.bundles[record.target];
	if (!bundle || record.archive?.sha256 !== bundle.sha256 || record.runner?.osArchitecture !== platformNativeInfo(record.target).arch || record.executor?.emulated !== false || record.tui?.observedOutput !== true || record.tui?.cleanExit !== true || record.clipboard?.loadedAndCalled !== true || record.thirdPartyNotices?.file !== "THIRD_PARTY_NOTICES.md" || !/^[0-9a-f]{64}$/.test(record.thirdPartyNotices?.sha256 ?? "") || !Number.isSafeInteger(record.thirdPartyNotices?.bytes)) throw new Error(`Invalid acceptance evidence for ${record.target}`);
	const notice = readArchivedNotice(join(releaseDir, bundle.file), record.target);
	if (notice.sha256 !== record.thirdPartyNotices.sha256 || notice.bytes !== record.thirdPartyNotices.bytes) throw new Error(`Archived third-party notices mismatch for ${record.target}`);
}
if (sums.size !== assets.length - 1) throw new Error("SHA256SUMS must contain bundles, manifest, installers, and acceptance record only");
const subjects = readFileSync(join(releaseDir, ATTESTATION_SUBJECTS_FILENAME), "utf8").trim().split(/\r?\n/).sort();
if (JSON.stringify(subjects) !== JSON.stringify([...assets].sort()) || subjects.some((subject) => basename(subject) !== subject)) throw new Error("Attestation subjects do not match exact Release assets");
for (const file of [INSTALL_SH_FILENAME, INSTALL_PS1_FILENAME]) {
	const content = readFileSync(join(releaseDir, file), "utf8");
	if (!content.includes(manifest.tag) || !content.includes(sha256File(manifestPath))) throw new Error(`${file} does not embed exact manifest pins`);
}
const platform = hostPlatform();
if (platform && manifest.bundles[platform]) smokeHostBundle(join(releaseDir, manifest.bundles[platform].file), platform, manifest.distributionVersion);
console.log(`${mode}: exact Release assets and binary contract verified`);
