import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { mock } from "node:test";
import { muslSmokeLibraries, muslSmokeProcessTools } from "./prepare-musl-smoke.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(root, "prepare-musl-smoke.mjs"), "utf8");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(arch, machine = arch === "x64" ? 62 : 183) {
	const directory = mkdtempSync(join(tmpdir(), "pi-musl-process-tools-"));
	let rebound = source;
	for (const [name, digest] of Object.entries(muslSmokeProcessTools(arch))) {
		const bytes = Buffer.alloc(96);
		bytes.write("\x7fELF", "binary");
		bytes[4] = 2;
		bytes[5] = 1;
		bytes.writeUInt16LE(machine, 18);
		bytes.write(name, 24);
		const file = join(directory, name);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, bytes, { mode: name === "bin/ps" ? 0o755 : 0o644 });
		rebound = rebound.replaceAll(digest, sha256(bytes));
	}
	// Only pinned bytes change in this private module; verification code and real SHA256 stay intact.
	const modulePath = join(directory, "prepare-musl-smoke.mjs");
	writeFileSync(modulePath, rebound);
	const { verifyMuslSmokeProcessTools } = await import(pathToFileURL(modulePath).href);
	return { directory, verify: () => verifyMuslSmokeProcessTools(directory, arch), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("procps closure stays separate from the original five XCB acceptance libraries", () => {
	for (const arch of ["x64", "arm64"]) {
		assert.deepEqual(Object.keys(muslSmokeLibraries(arch)), ["libxcb.so.1", "libXau.so.6", "libXdmcp.so.6", "libbsd.so.0", "libmd.so.0"]);
		assert.deepEqual(Object.keys(muslSmokeProcessTools(arch)), ["bin/ps", "usr/lib/libintl.so.8", "usr/lib/libproc2.so.0", "usr/lib/libutmps.so.0.1", "usr/lib/libskarnet.so.2.14"]);
		for (const digest of Object.values(muslSmokeProcessTools(arch))) assert.match(digest, /^[a-f0-9]{64}$/);
	}
	assert.throws(() => muslSmokeProcessTools("ppc64"), /unsupported musl architecture/);
});

for (const arch of ["x64", "arm64"]) {
	test(`${arch} process tools require every pinned ELF and executable ps`, async () => {
		const f = await fixture(arch);
		try {
			assert.equal(Object.keys(f.verify()).length, 5);
			chmodSync(join(f.directory, "bin/ps"), 0o644);
			assert.throws(f.verify, /ps is not executable/);
		} finally { f.cleanup(); }
	});
	for (const missing of ["bin/ps", "usr/lib/libproc2.so.0"]) {
		test(`${arch} missing ${missing} fails closed`, async () => {
			const f = await fixture(arch);
			try {
				rmSync(join(f.directory, missing));
				assert.throws(f.verify, /ENOENT/);
			} finally { f.cleanup(); }
		});
	}
	test(`${arch} changed tool bytes fail the real SHA256 check`, async () => {
		const f = await fixture(arch);
		try {
			const file = join(f.directory, "bin/ps");
			const bytes = readFileSync(file);
			bytes[95] ^= 1;
			writeFileSync(file, bytes);
			assert.throws(f.verify, /process tool digest mismatch/);
		} finally { f.cleanup(); }
	});
	test(`${arch} wrong-architecture ELF is rejected even with a matching digest`, async () => {
		const f = await fixture(arch, arch === "x64" ? 183 : 62);
		try { assert.throws(f.verify, /process tool architecture mismatch/); }
		finally { f.cleanup(); }
	});
}

test("preparation rejects a changed procps APK before extracting or using it", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-musl-apk-rejection-"));
	const modulePath = join(directory, "prepare-musl-smoke.mjs");
	const valid = Buffer.from("private XCB archive fixture");
	let rebound = source;
	const xcb = source.slice(source.indexOf("x64: ["), source.indexOf("arm64: ["));
	for (const [, digest] of xcb.matchAll(/\["[^\"]+\.apk", "([a-f0-9]{64})"/g)) rebound = rebound.replace(digest, sha256(valid));
	writeFileSync(modulePath, rebound);
	const argv = process.argv;
	const fetch = globalThis.fetch;
	const requests = [];
	const tar = mock.method(childProcess, "execFileSync", () => Buffer.alloc(0));
	syncBuiltinESMExports();
	try {
		process.argv = [process.execPath, modulePath, "x64", join(directory, "output")];
		globalThis.fetch = async (url) => {
			requests.push(url);
			return new Response(requests.length <= 5 ? valid : "wrong procps archive bytes");
		};
		await assert.rejects(import(pathToFileURL(modulePath).href), /APK digest mismatch: procps-ng-4\.0\.4-r3\.apk/);
		assert.equal(requests.length, 6);
		assert.ok(requests[5].endsWith("/procps-ng-4.0.4-r3.apk"));
		assert.equal(tar.mock.calls.length, 5, "the rejected procps APK must never reach tar");
		assert.equal(readdirSync(join(directory, "output")).length, 5);
		assert.equal(existsSync(join(directory, "output", "bin", "ps")), false);
	} finally {
		process.argv = argv;
		globalThis.fetch = fetch;
		tar.mock.restore();
		syncBuiltinESMExports();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("musl runtime selects read-only procps before owner inventory without changing XCB evidence", () => {
	const workflow = readFileSync(join(root, "../.github/workflows/publish-github-release.yml"), "utf8");
	const command = workflow.split("\n").find((line) => line.includes('"/record/${{ matrix.target }}.json"'));
	assert.ok(command);
	assert.match(command, /--network none/);
	assert.match(command, /musl-libraries:\/musl-libraries:ro/);
	assert.ok(command.includes('sh -c \'PATH="/musl-libraries/bin:$PATH" exec bun "$@"\' sh scripts/smoke-binary-release.mjs'));
	const smoke = readFileSync(join(root, "smoke-binary-release.mjs"), "utf8");
	const verify = smoke.indexOf('verifyMuslSmokeProcessTools(process.env.PI_XZ_MUSL_LIBRARIES, target.arch)');
	assert.ok(verify >= 0 && verify < smoke.indexOf("const ownerStarted"));
	assert.match(smoke, /libraries: muslLibraries/);
});
