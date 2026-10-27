import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bunTarget } from "./lib/bun-targets.mjs";
import { muslSmokeLibraries, muslSmokeProcessTools } from "./prepare-musl-smoke.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rootIdentity = { uid: 0, euid: 0, elevated: true };

async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-owner-transport-"));
	const modules = join(directory, "scripts");
	mkdirSync(join(modules, "lib"), { recursive: true });
	for (const name of ["smoke-owner-lifecycle.mjs", "smoke-unix-owner-pty.mjs", "smoke-windows-owner-gate.mjs", "lib/bun-targets.mjs"]) copyFileSync(join(scripts, name), join(modules, name));
	cpSync(join(scripts, "fixtures", "owner"), join(modules, "fixtures", "owner"), { recursive: true });
	// Rebind only fixture hashes, preserving real verification and the actual collector launch seam.
	let source = readFileSync(join(scripts, "prepare-musl-smoke.mjs"), "utf8");
	const bundle = join(directory, "bundle");
	for (const arch of ["x64", "arm64"]) {
		const inputs = { ...Object.fromEntries(Object.entries(muslSmokeLibraries(arch)).map(([name, digest]) => [`usr/lib/${name}`, digest])), ...muslSmokeProcessTools(arch) };
		for (const [name, digest] of Object.entries(inputs)) {
			const bytes = Buffer.alloc(64);
			bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
			bytes.writeUInt16LE(62, 18);
			bytes.write(name, 24);
			mkdirSync(dirname(join(bundle, name)), { recursive: true });
			writeFileSync(join(bundle, name), bytes, { mode: name === "bin/ps" ? 0o755 : 0o644 });
			source = source.replaceAll(digest, hash(bytes));
		}
	}
	writeFileSync(join(modules, "prepare-musl-smoke.mjs"), source);
	const { smokeOwnerLifecycleAsNonadmin } = await import(pathToFileURL(join(modules, "smoke-owner-lifecycle.mjs")).href);
	return { directory, bundle, collect: smokeOwnerLifecycleAsNonadmin };
}

async function launch(f, { target = "linux-x64-musl-baseline", bundle = f.bundle, probe = true } = {}) {
	let childEnv;
	let child;
	let protectedTools;
	const evidence = await f.collect(process.execPath, bunTarget(target), {
		platform: "linux", identityProbe: () => rootIdentity,
		env: { CI: "true", PI_XZ_EXECUTOR: "pinned-musl-container", PI_OWNER_PTY_HARNESS: process.execPath, PI_XZ_MUSL_LIBRARIES: bundle, PATH: "/parent-poison", LD_LIBRARY_PATH: "/parent-poison-libraries", NODE_OPTIONS: "parent-poison" },
		run(file, args, options) {
			if (file === "id") return { status: 1, stdout: "", stderr: "" };
			if (file !== "su") return { status: 0, stdout: "", stderr: "" };
			assert.ok(args.at(-1).startsWith("exec 'env' '-i' "));
			childEnv = Object.fromEntries([...args.at(-1).matchAll(/'([A-Z][A-Z0-9_]*=[^']*)'/g)].map((m) => { const i = m[1].indexOf("="); return [m[1].slice(0, i), m[1].slice(i + 1)]; }));
			if (childEnv.PI_XZ_MUSL_LIBRARIES) {
				assert.equal(existsSync(join(options.cwd, "scripts", "prepare-musl-smoke.mjs")), true);
				protectedTools = childEnv.PI_XZ_MUSL_LIBRARIES;
				assert.notEqual(protectedTools, f.bundle);
				assert.equal(protectedTools.startsWith(`${options.cwd}/`), false);
				assert.equal(lstatSync(protectedTools).mode & 0o777, 0o755);
				assert.equal(lstatSync(join(protectedTools, "bin/ps")).mode & 0o777, 0o555);
				assert.equal(lstatSync(join(protectedTools, "usr/lib/libproc2.so.0")).mode & 0o777, 0o444);
				assert.equal(childEnv.PATH.split(":")[0], join(protectedTools, "bin"));
			}
			if (probe) child = spawnSync("env", ["-i", ...Object.entries(childEnv).map(([key, value]) => `${key}=${value}`), process.execPath, "-e", 'const {spawnSync}=require("node:child_process");const ps=spawnSync("/bin/sh",["-c","command -v ps"],{encoding:"utf8"});if(ps.status!==0)process.exit(1);console.log(JSON.stringify({ps:ps.stdout.trim(),ld:process.env.LD_LIBRARY_PATH,bundle:process.env.PI_XZ_MUSL_LIBRARIES,nodeOptions:process.env.NODE_OPTIONS}));'], { encoding: "utf8", timeout: 10_000 });
			return { status: 37, stdout: "", stderr: "seam probe only; no account, UID change or Pi lifecycle" };
		},
	});
	if (protectedTools) assert.equal(existsSync(protectedTools), false, "protected tools cleaned even on child failure");
	return { evidence, childEnv, child };
}

test("musl verified tools and libraries survive actual env-i child launch without parent poison", async () => {
	const f = await fixture();
	try {
		const { childEnv, child } = await launch(f);
		assert.ok(childEnv?.PI_XZ_MUSL_LIBRARIES);
		assert.equal(child.status, 0, child.stderr);
		const observed = JSON.parse(child.stdout);
		assert.equal(observed.ps, join(childEnv.PI_XZ_MUSL_LIBRARIES, "bin/ps"));
		assert.equal(observed.ld, join(childEnv.PI_XZ_MUSL_LIBRARIES, "usr/lib"));
		assert.equal(observed.bundle, childEnv.PI_XZ_MUSL_LIBRARIES);
		assert.equal(observed.nodeOptions, undefined);
		assert.equal(JSON.stringify(childEnv).includes("parent-poison"), false);
	} finally { rmSync(f.directory, { recursive: true, force: true }); }
});

for (const invalid of ["absent", "missing", "tampered", "wrong-arch", "non-executable", "writable-file", "writable-directory", "writable-root", "sticky-root", "escaping-link"]) {
	test(`musl ${invalid} bundle fails before dedicated-user launch`, async () => {
		const f = await fixture();
		try {
			const ps = join(f.bundle, "bin/ps");
			if (invalid === "missing") rmSync(ps);
			if (invalid === "tampered") writeFileSync(ps, "wrong bytes");
			if (invalid === "non-executable") chmodSync(ps, 0o644);
			if (invalid === "writable-file") chmodSync(ps, 0o777);
			if (invalid === "writable-directory") chmodSync(join(f.bundle, "bin"), 0o777);
			if (invalid === "writable-root") chmodSync(f.bundle, 0o777);
			if (invalid === "sticky-root") chmodSync(f.bundle, 0o1777);
			if (invalid === "escaping-link") { const outside = join(f.directory, "outside-ps"); copyFileSync(ps, outside); rmSync(ps); symlinkSync(outside, ps); }
			const { evidence, childEnv } = await launch(f, { ...(invalid === "absent" ? { bundle: "" } : {}), ...(invalid === "wrong-arch" ? { target: "linux-arm64-musl" } : {}) });
			assert.equal(childEnv, undefined);
			assert.equal(evidence.status, "failed");
			assert.match(evidence.error, /requires|ENOENT|changed before staging|architecture mismatch|insecure|escapes/);
		} finally { rmSync(f.directory, { recursive: true, force: true }); }
	});
}

test("GNU dedicated-user environment ignores musl and parent library variables", async () => {
	const f = await fixture();
	try {
		const { childEnv, child } = await launch(f, { target: "linux-x64-gnu-baseline", bundle: "", probe: true });
		assert.ok(childEnv);
		assert.equal(child.status, 0, child.stderr);
		assert.equal(childEnv.LD_LIBRARY_PATH, undefined);
		assert.equal(childEnv.PI_XZ_MUSL_LIBRARIES, undefined);
		assert.equal(JSON.stringify(childEnv).includes("parent-poison"), false);
	} finally { rmSync(f.directory, { recursive: true, force: true }); }
});
