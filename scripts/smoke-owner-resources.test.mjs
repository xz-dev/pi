import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { inspectOwnerArtifact } from "./fixtures/owner/extension.mjs";
import { ownerLifecycleEnvironment } from "./smoke-owner-lifecycle.mjs";

test("installed owner gate forces a fresh default-on claim without mutating caller environment", () => {
	const source = Object.freeze({
		PATH: "ordinary path",
		PROCWARD_TEST_VALUE: "ordinary value",
		PI_NO_PROCESS_OWNERSHIP: "1",
		PI_PROCWARD_BIN: "foreign helper",
		PI_PACKAGE_DIR: "foreign metadata",
		PI_PROCWARD_BOOTSTRAP_NONCE: "old nonce",
		PROCWARD_PROTOCOL: "1",
		PROCWARD_OWNER_PID: "42",
		PROCWARD_PRIMARY_PID: "43",
		PROCWARD_CONTRACT_ID: "stale",
		PROCWARD_LIFECYCLE_FD: "3",
		PROCWARD_LIFECYCLE_HANDLE: "9007199254740993",
		PI_PROCESS_OWNER_PID: "42",
		PI_PROCESS_OWNER_PENDING: "1",
		PI_PROCESS_OWNER_BINARY: "obsolete",
		PI_STARTUP_BENCHMARK: "1",
	});
	assert.deepEqual(ownerLifecycleEnvironment(source), { PATH: "ordinary path", PROCWARD_TEST_VALUE: "ordinary value" });
	assert.equal(source.PI_NO_PROCESS_OWNERSHIP, "1");
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-shipped-owner-"));
	const embedded = join(root, "embedded");
	const resources = join(root, "pi-resources--1");
	const target = "windows-x64-baseline";
	const version = "1.5.0-xz.415.1.gabc";
	const data = Buffer.from("source-built embedded helper; never executed");
	const source = join(embedded, "process-owner", "procward.exe");
	const owner = join(resources, target, version, "process-owner", "procward.exe");
	for (const file of [source, owner]) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, data);
	}
	const metadata = { version, piConfig: { releaseTarget: target } };
	writeFileSync(join(embedded, "package.json"), JSON.stringify(metadata));
	return { root, embedded, resources, source, owner, metadata, data };
}

test("shipped owner identity uses canonical target/version materialization and exact embedded bytes", () => {
	const f = fixture();
	try {
		assert.deepEqual(inspectOwnerArtifact(f.embedded, f.resources), {
			owner: f.owner,
			ownerSha256: createHash("sha256").update(f.data).digest("hex"),
			artifactVersion: f.metadata.version,
			artifactTarget: f.metadata.piConfig.releaseTarget,
		});
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("shipped owner identity rejects tampered cache rather than repairing it or trusting a path", () => {
	const f = fixture();
	try {
		writeFileSync(f.owner, "different helper");
		assert.throws(() => inspectOwnerArtifact(f.embedded, f.resources), /embedded.*differ/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("shipped owner identity requires the already materialized helper and does not create it", () => {
	const f = fixture();
	try {
		rmSync(f.owner);
		assert.throws(() => inspectOwnerArtifact(f.embedded, f.resources), /ENOENT/);
		assert.equal(existsSync(f.owner), false);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("shipped owner identity rejects absent or unsafe build metadata before accepting resources", () => {
	for (const metadata of [
		{},
		{ version: "../escape", piConfig: { releaseTarget: "windows-x64-baseline" } },
		{ version: "..\\escape", piConfig: { releaseTarget: "windows-x64-baseline" } },
		{ version: "1.5.0", piConfig: { releaseTarget: "invented-target" } },
	]) {
		const f = fixture();
		try {
			writeFileSync(join(f.embedded, "package.json"), JSON.stringify(metadata));
			assert.throws(() => inspectOwnerArtifact(f.embedded, f.resources));
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	}
});
