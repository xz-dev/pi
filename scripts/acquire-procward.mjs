#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUN_TARGETS, bunTarget, isMainModulePath } from "./lib/bun-targets.mjs";
import { PROCWARD_PIN } from "./lib/procward-pin.mjs";

const sha256 = /^[0-9a-f]{64}$/;
export function validateProcwardPin(pin = PROCWARD_PIN, { allowDev = false } = {}) {
	if (pin.state !== "release" && !(allowDev && pin.state === "unpinned-dev")) throw new Error("procward pin is unpinned-dev; publishing is forbidden");
	if (pin.repository !== "xz-dev/procward" || pin.workflow !== ".github/workflows/release.yml" || !/^[0-9a-f]{40}$/.test(pin.sourceCommit)) throw new Error("Invalid procward source identity");
	if (!/^\d+\.\d+\.\d+$/.test(pin.version)) throw new Error("Invalid procward version");
	if (pin.state === "release" && pin.tag !== `v${pin.version}`) throw new Error("procward release tag must match version");
	const targets = [...new Set(BUN_TARGETS.map((target) => target.cargoTarget))];
	if (Object.keys(pin.targets).sort().join() !== targets.sort().join()) throw new Error("procward pin must cover exactly Pi's ten Rust targets");
	for (const target of targets) {
		const asset = pin.targets[target];
		if (!asset && pin.state === "unpinned-dev") continue;
		if (!asset || !sha256.test(asset.zipSha256) || !sha256.test(asset.binarySha256)) throw new Error(`Missing procward digests: ${target}`);
	}
	return pin;
}

function gh(args, options = {}) {
	return execFileSync("gh", args, { encoding: "utf8", timeout: 180000, stdio: ["ignore", "pipe", "inherit"], ...options });
}

export function acquireProcward(targetId, output, { allowDev = false } = {}) {
	const pin = validateProcwardPin(PROCWARD_PIN, { allowDev });
	const target = bunTarget(targetId).cargoTarget;
	const asset = pin.targets[target];
	if (!asset) throw new Error(`No verified development asset recorded for ${target}`);
	const binary = target.includes("windows") ? "procward.exe" : "procward";
	const archive = `procward-${target}.zip`;
	mkdirSync(dirname(resolve(output)), { recursive: true });
	const scratch = mkdtempSync(join(dirname(resolve(output)), ".procward-acquire-"));
	try {
		if (pin.state === "release") {
			gh(["release", "verify", pin.tag, "--repo", pin.repository]);
			gh(["release", "download", pin.tag, "--repo", pin.repository, "--pattern", archive, "--pattern", "SHA256SUMS", "--dir", scratch]);
			for (const name of [archive, "SHA256SUMS"]) {
				gh(["release", "verify-asset", pin.tag, join(scratch, name), "--repo", pin.repository]);
				attest(join(scratch, name), pin);
			}
			const sums = readFileSync(join(scratch, "SHA256SUMS"), "utf8").split(/\r?\n/);
			const matches = sums.filter((line) => line.endsWith(`  ${archive}`) || line.endsWith(`  ${target}/${archive}`));
			if (matches.length !== 1 || matches[0].slice(0, 64) !== asset.zipSha256) throw new Error("procward checksum manifest mismatch");
		} else {
			const run = JSON.parse(gh(["api", `repos/${pin.repository}/actions/runs/${pin.developmentRun}`]));
			if (run.head_sha !== pin.sourceCommit || run.head_branch !== "main" || run.path !== pin.workflow || run.repository?.full_name !== pin.repository) throw new Error("procward development build source mismatch");
			gh(["run", "download", String(pin.developmentRun), "--repo", pin.repository, "--name", `packages-${target}`, "--dir", scratch]);
		}
		const stage = join(scratch, "verified");
		execFileSync(process.platform === "freebsd" ? "python3.11" : "python3", [fileURLToPath(new URL("./lib/extract-procward.py", import.meta.url)), join(scratch, archive), stage, binary, asset.zipSha256, asset.binarySha256], { stdio: "inherit", timeout: 30000 });
		if (pin.state === "release") attest(join(stage, binary), pin);
		for (const name of ["LICENSE", "third-party-licenses.md"]) {
			const notice = readFileSync(fileURLToPath(new URL(`./vendor/procward/${name}`, import.meta.url)));
			if (!notice.equals(readFileSync(join(stage, name)))) throw new Error(`procward ${name} changed; review and update vendored legal notices before bundling`);
		}
		const manifest = { state: pin.state, version: pin.version, repository: pin.repository, workflow: pin.workflow, sourceCommit: pin.sourceCommit, tag: pin.tag, target, ...asset };
		writeFileSync(join(stage, "pin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		chmodSync(join(stage, binary), 0o700);
		mkdirSync(dirname(resolve(output)), { recursive: true });
		renameSync(stage, resolve(output));
		return manifest;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function attest(file, pin) {
	gh(["attestation", "verify", file, "--repo", pin.repository, "--signer-workflow", `${pin.repository}/${pin.workflow}`, "--source-ref", `refs/tags/${pin.tag}`, "--source-digest", pin.sourceCommit, "--deny-self-hosted-runners"]);
}

if (process.argv[1] && isMainModulePath(fileURLToPath(import.meta.url), process.argv[1])) {
	const [command, target, output, ...rest] = process.argv.slice(2);
	if (command === "--require-release") validateProcwardPin();
	else if (command === "--target" && target && output && rest.every((arg) => arg === "--allow-dev")) acquireProcward(target, output, { allowDev: rest.includes("--allow-dev") });
	else throw new Error("Usage: acquire-procward.mjs --require-release | --target <Bun target> <new output directory> [--allow-dev]");
}
