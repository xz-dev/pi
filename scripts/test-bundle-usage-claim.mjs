#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { types as utilTypes } from "node:util";

const [moduleArg, guardArg] = process.argv.slice(2);
if (!moduleArg || !guardArg) {
	throw new Error("Usage: test-bundle-usage-claim.mjs <pi-usage-claim.node> <usage.lock>");
}
const modulePath = resolve(moduleArg);
const guardPath = resolve(guardArg);
if (!existsSync(modulePath)) throw new Error(`usage claim module missing: ${modulePath}`);
if (!readFileSync(guardPath).equals(Buffer.from("P"))) throw new Error("usage guard payload is invalid");
const claim = createRequire(import.meta.url)(modulePath);
const mockMode = process.env.PI_XZ_USAGE_CLAIM_MOCK === "1";
const isOwner = (value) => utilTypes.isExternal(value) || (mockMode && value?.mockUsageClaim === true);
if (typeof claim.acquire !== "function" || typeof claim.releaseScoped !== "function") {
	throw new Error("usage claim module API is invalid");
}

const marker = join(dirname(guardPath), `.usage-claim-holder-${process.pid}`);
const childScript = `const fs=require("node:fs");const m=require(${JSON.stringify(modulePath)});const result=m.acquire(${JSON.stringify(guardPath)},"shared","session");if(result!=="acquired")process.exit(3);fs.writeFileSync(${JSON.stringify(marker)},"1");setInterval(()=>{},1000);`;
const holder = spawn(process.execPath, ["--eval", childScript], { stdio: "ignore" });
try {
	const deadline = Date.now() + 10_000;
	while (!existsSync(marker)) {
		if (holder.exitCode !== null) throw new Error(`usage holder exited before readiness: ${holder.exitCode}`);
		if (Date.now() >= deadline) throw new Error("usage holder readiness timeout");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	}
	if (claim.acquire(guardPath, "exclusive", "scoped") !== "busy") {
		throw new Error("exclusive claim succeeded while a shared holder was alive");
	}
	const secondShared = claim.acquire(guardPath, "shared", "scoped");
	if (!isOwner(secondShared)) throw new Error("second shared claim did not return a native external owner");
	claim.releaseScoped(secondShared);
	holder.kill("SIGKILL");
	await new Promise((resolvePromise) => holder.once("exit", resolvePromise));
	if (mockMode) rmSync(`${guardPath}.shared`, { force: true });

	const exclusive = claim.acquire(guardPath, "exclusive", "scoped");
	if (!isOwner(exclusive)) throw new Error("exclusive claim was not available after holder exit");
	// The lock range begins at offset 1, so reading the immutable payload byte
	// through a second handle must still work on Windows.
	if (!readFileSync(guardPath).equals(Buffer.from("P"))) throw new Error("guard payload became unreadable under lock");
	const movedGuard = `${guardPath}.retired`;
	renameSync(guardPath, movedGuard);
	claim.releaseScoped(exclusive);
	renameSync(movedGuard, guardPath);

	console.log(
		JSON.stringify({
			module: basename(modulePath),
			sharedContention: true,
			multipleShared: true,
			crashRelease: true,
			payloadReadableUnderExclusive: true,
			renameUnderExclusive: true,
		}),
	);
} finally {
	holder.kill("SIGKILL");
	rmSync(marker, { force: true });
}
