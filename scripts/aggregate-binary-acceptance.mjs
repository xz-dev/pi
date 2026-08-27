#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { BUN_TARGET_IDS, SMOKE_LIMITS, bunTarget } from "./lib/bun-targets.mjs";
const [recordsArg, manifestArg, outputArg] = process.argv.slice(2);
if (!recordsArg || !manifestArg || !outputArg) throw new Error("Usage: aggregate-binary-acceptance.mjs <records-dir> <manifest> <output>");
const recordsDir = resolve(recordsArg); const manifestPath = resolve(manifestArg); const output = resolve(outputArg);
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function archiveNotice(archive) {
	const work = mkdtempSync(join(tmpdir(), "pi-notice-"));
	try {
		execFileSync("unzip", ["-q", archive, "THIRD_PARTY_NOTICES.md", "-d", work]);
		const path = join(work, "THIRD_PARTY_NOTICES.md");
		return { sha256: sha256(path), bytes: statSync(path).size };
	} finally { rmSync(work, { recursive: true, force: true }); }
}
const files = readdirSync(recordsDir, { recursive: true }).filter((file) => file.endsWith(".json"));
const records = files.map((file) => JSON.parse(readFileSync(join(recordsDir, file), "utf8")));
if (records.length !== BUN_TARGET_IDS.length) throw new Error(`expected exactly ${BUN_TARGET_IDS.length} smoke records, found ${records.length}`);
const byTarget = new Map(records.map((record) => [record.target, record]));
if (byTarget.size !== BUN_TARGET_IDS.length || BUN_TARGET_IDS.some((id) => !byTarget.has(id))) throw new Error("smoke records do not cover exact authoritative targets");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const normalizeRunnerArch = (value) => value === "ARM64" ? "arm64" : value === "X64" ? "x64" : value;
const assertLimit = (id, name, actual, maximum) => { if (!Number.isSafeInteger(actual) || actual < 0 || actual > maximum) throw new Error(`${id} ${name} ${actual} exceeds authoritative limit ${maximum}`); };
for (const id of BUN_TARGET_IDS) {
	const descriptor = bunTarget(id); const record = byTarget.get(id); const bundle = manifest.bundles?.[id];
	if (!bundle || record.schemaVersion !== 1 || record.archive?.file !== bundle.file || record.archive.sha256 !== bundle.sha256 || record.archive.bytes !== bundle.bytes) throw new Error(`${id} archive identity mismatch`);
	if (record.runner?.os !== descriptor.runnerOs || normalizeRunnerArch(record.runner?.arch) !== descriptor.arch || record.runner?.osArchitecture !== descriptor.arch) throw new Error(`${id} runner OS/architecture does not match authoritative descriptor`);
	if (record.executor?.kind !== descriptor.executor || record.executor?.emulated !== false) throw new Error(`${id} executor does not match authoritative descriptor`);
	if ((record.executor.containerDigest ?? null) !== (descriptor.containerImage ?? null)) throw new Error(`${id} container digest does not match authoritative descriptor`);
	const features = String(record.runner.cpuFeatures ?? "").toLowerCase().replaceAll(".", "_");
	for (const feature of descriptor.requiredCpuFeatures) if (!features.includes(feature)) throw new Error(`${id} CPU lacks required ${feature}`);
	const commands = record.commands ?? [];
	if (JSON.stringify(commands.map(({ name }) => name)) !== JSON.stringify(descriptor.requiredCommands)) throw new Error(`${id} command inventory does not match authoritative descriptor`);
	for (const command of commands) if (command.status !== 0 || !Number.isSafeInteger(command.elapsedMs) || command.elapsedMs < 0) throw new Error(`${id} invalid command evidence: ${command.name}`);
	assertLimit(id, "archiveBytes", record.archive.bytes, SMOKE_LIMITS.archiveBytes);
	assertLimit(id, "extractedBytes", record.archive.extractedBytes, SMOKE_LIMITS.extractedBytes);
	assertLimit(id, "coldVersionMs", record.timingsMs?.coldVersion, SMOKE_LIMITS.coldVersionMs);
	assertLimit(id, "versionMs", record.timingsMs?.version, SMOKE_LIMITS.versionMs);
	assertLimit(id, "helpMs", record.timingsMs?.help, SMOKE_LIMITS.helpMs);
	assertLimit(id, "listModelsMs", record.timingsMs?.listModels, SMOKE_LIMITS.listModelsMs);
	assertLimit(id, "interactiveMs", record.tui?.elapsedMs, SMOKE_LIMITS.interactiveMs);
	if (JSON.stringify(record.limits) !== JSON.stringify(SMOKE_LIMITS)) throw new Error(`${id} self-reported limits do not equal authoritative limits`);
	const expectedTui = descriptor.os === "windows" ? { harness: "Bun.Terminal ConPTY", input: "startup-benchmark", exitSent: false, benchmarkCompleted: true } : { harness: "Bun.Terminal PTY", input: "ctrl-c,ctrl-d", exitSent: true, benchmarkCompleted: null };
	if (!Number.isSafeInteger(record.tui?.outputBytes) || record.tui.outputBytes <= 0 || record.tui.harness !== expectedTui.harness || record.tui.input !== expectedTui.input || record.tui.childExitCode !== 0 || !record.tui.terminalClosed || !Number.isSafeInteger(record.tui.terminalExitCode) || !record.tui.observedOutput || record.tui.benchmarkCompleted !== expectedTui.benchmarkCompleted || record.tui.exitSent !== expectedTui.exitSent || !record.tui.cleanExit || !record.clipboard?.loadedAndCalled) throw new Error(`${id} missing bounded TUI or clipboard acceptance`);
	if (descriptor.os === "windows") {
		if (
			record.filesystemSnapshot?.apiVersion !== 1 ||
			record.filesystemSnapshot?.arch !== descriptor.arch ||
			record.filesystemSnapshot?.reparseRejected !== true ||
			record.filesystemSnapshot?.ancestorReparseCanonicalized !== true ||
			record.filesystemSnapshot?.extendedPathValidated !== true ||
			record.filesystemSnapshot?.longPathValidated !== true ||
			record.filesystemSnapshot?.uncValidated !== true ||
			record.filesystemSnapshot?.concurrentSnapshotsCoherent !== true ||
			record.filesystemSnapshot?.loader?.missingRejected !== true ||
			record.filesystemSnapshot?.loader?.corruptRejectedWithoutFallback !== true ||
			record.filesystemSnapshot?.loader?.oppositeArchitectureRejected !== true ||
			record.filesystemSnapshot?.loader?.apiMismatchRejected !== true ||
			record.filesystemSnapshot?.loader?.malformedNativeResultsRejected !== true ||
			record.filesystemSnapshot?.loader?.malformedExportsRejected !== true ||
			record.filesystemSnapshot?.loader?.malformedResultsRejected !== true
		) throw new Error(`${id} missing Win32 filesystem snapshot acceptance`);
	} else if (record.filesystemSnapshot !== null) {
		throw new Error(`${id} reported unexpected Win32 filesystem snapshot evidence`);
	}
	if (record.thirdPartyNotices?.file !== "THIRD_PARTY_NOTICES.md" || !/^[0-9a-f]{64}$/.test(record.thirdPartyNotices?.sha256 ?? "") || !Number.isSafeInteger(record.thirdPartyNotices?.bytes) || record.thirdPartyNotices.bytes <= 0) throw new Error(`${id} missing third-party license closure evidence`);
	const notice = archiveNotice(join(resolve(manifestPath, ".."), bundle.file));
	if (notice.sha256 !== record.thirdPartyNotices.sha256 || notice.bytes !== record.thirdPartyNotices.bytes) throw new Error(`${id} archived third-party notices do not match acceptance evidence`);
}
const acceptance = { schemaVersion: 1, manifest: { file: basename(manifestPath), sha256: sha256(manifestPath), schemaVersion: manifest.schemaVersion, commit: manifest.commit }, targetCount: BUN_TARGET_IDS.length, targets: BUN_TARGET_IDS.map((id) => byTarget.get(id)) };
writeFileSync(output, `${JSON.stringify(acceptance, null, 2)}\n`);
const releaseDir = resolve(output, "..");
const sumsPath = join(releaseDir, "SHA256SUMS");
const subjectsPath = join(releaseDir, manifest.attestation.subjectsFile);
const outputName = basename(output);
const sums = readFileSync(sumsPath, "utf8").trimEnd().split(/\r?\n/).filter((line) => !line.endsWith(`  ${outputName}`));
sums.push(`${sha256(output)}  ${outputName}`); sums.sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
writeFileSync(sumsPath, `${sums.join("\n")}\n`);
const subjects = readFileSync(subjectsPath, "utf8").trimEnd().split(/\r?\n/).filter((line) => line !== outputName);
subjects.push(outputName); writeFileSync(subjectsPath, `${subjects.join("\n")}\n`);
console.log(`${output} ${sha256(output)}`);
