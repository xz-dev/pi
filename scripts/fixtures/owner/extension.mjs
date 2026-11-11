// Deliberately starts work in the factory: tests the CLI owner before any model or session is needed.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bunTarget } from "../../lib/bun-targets.mjs";

export function inspectOwnerArtifact(embeddedRoot, resourcesRoot) {
	const pkg = JSON.parse(readFileSync(join(embeddedRoot, "package.json"), "utf8").replace(/^\uFEFF/, ""));
	if (typeof pkg.version !== "string" || !pkg.version || /[/\\]/.test(pkg.version) || [".", ".."].includes(pkg.version)) throw new Error("Missing or unsafe embedded artifact version");
	const target = bunTarget(pkg.piConfig?.releaseTarget);
	const name = target.os === "windows" ? "procward.exe" : "procward";
	const owner = join(resourcesRoot, target.id, pkg.version, "process-owner", name);
	const embedded = readFileSync(join(embeddedRoot, "process-owner", name));
	if (!embedded.length || !embedded.equals(readFileSync(owner))) throw new Error("Materialized owner and embedded helper bytes differ");
	return { owner, ownerSha256: createHash("sha256").update(embedded).digest("hex"), artifactVersion: pkg.version, artifactTarget: target.id };
}

export default async function () {
	let user;
	try { user = String(userInfo().uid); } catch { user = process.env.USER || process.env.USERNAME || "unknown"; }
	const embeddedRoot = process.platform === "win32" ? "B:/~BUN/root" : "/$bunfs/root";
	const artifact = inspectOwnerArtifact(embeddedRoot, join(tmpdir(), `pi-resources-${user}`));
	const child = spawn(process.env.PI_OWNER_RUNTIME, [join(process.env.PI_OWNER_FIXTURES, "descendant.mjs"), "bridge"], { stdio: "ignore" });
	await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`owner fixture bridge: ${code}`)));
	});
	// Atomic publish: the smoke polls existsSync(ready), so a plain write can be observed empty.
	writeFileSync(`${process.env.PI_OWNER_READY}.tmp`, JSON.stringify({ pid: process.pid, uid: process.getuid?.() ?? null, bun: process.versions.bun ?? null, ...artifact }));
	renameSync(`${process.env.PI_OWNER_READY}.tmp`, process.env.PI_OWNER_READY);
	while (!existsSync(process.env.PI_OWNER_RELEASE)) await delay(10);
	process.exit(0);
}
