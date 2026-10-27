import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { smokeUnixOwnerPty } from "./smoke-unix-owner-pty.mjs";

// Filesystem setup only: a missing harness cannot supply native/PTY acceptance evidence.
const setup = (work, root) => smokeUnixOwnerPty(process.execPath, { id: "linux-x64-gnu-baseline", os: "linux" }, "suspend-resume", work, {}, { harness: join(root, "missing-harness") });

test("new PTY row directory stays private under permissive umask", { skip: process.platform === "win32" }, () => {
	const root = mkdtempSync(join(tmpdir(), "owner-pty-directory-"));
	const previous = process.umask(0o002);
	try {
		const work = join(root, "suspend-resume");
		assert.equal(setup(work, root).status, "failed");
		const directory = lstatSync(work);
		assert.ok(directory.isDirectory());
		assert.equal(directory.uid, process.getuid());
		assert.equal(directory.mode & 0o7777, 0o700);
		assert.equal(process.umask(), 0o002);
	} finally {
		process.umask(previous);
		rmSync(root, { recursive: true, force: true });
	}
});

test("PTY directory setup never normalizes preexisting unsafe paths or stale witness bytes", { skip: process.platform === "win32" }, () => {
	const root = mkdtempSync(join(tmpdir(), "owner-pty-existing-"));
	const previous = process.umask(0o002);
	try {
		const work = join(root, "unsafe");
		mkdirSync(work, { mode: 0o777 });
		const witness = join(work, "helper-witness");
		const stale = "owner-helper-v1 suspend-resume\nstale witness\n";
		writeFileSync(witness, stale, { mode: 0o600 });
		const directory = lstatSync(work);
		const file = lstatSync(witness);
		const link = join(root, "symlink");
		symlinkSync(work, link, "dir");
		const beforeLink = lstatSync(link);
		for (const path of [work, link]) {
			assert.equal(setup(path, root).status, "failed");
			assert.equal(lstatSync(work).mode, directory.mode);
			assert.equal(lstatSync(work).ino, directory.ino);
			assert.equal(lstatSync(witness).mode, file.mode);
			assert.equal(lstatSync(witness).ino, file.ino);
			assert.equal(readFileSync(witness, "utf8"), stale);
			assert.ok(lstatSync(link).isSymbolicLink());
			assert.equal(lstatSync(link).ino, beforeLink.ino);
		}
		assert.equal(directory.mode & 0o7777, 0o775);
	} finally {
		process.umask(previous);
		rmSync(root, { recursive: true, force: true });
	}
});
