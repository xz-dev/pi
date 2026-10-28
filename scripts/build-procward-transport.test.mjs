import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A running native consumer must keep its mapped inode while another build publishes replacement bytes.
test("procward transport publication leaves an open consumer's old bytes unchanged", () => {
	const work = mkdtempSync(join(tmpdir(), "pi-procward-publication-"));
	const output = join(work, "procward-transport.node");
	const previous = Buffer.from("previous transport held by a running consumer\n");
	writeFileSync(output, previous);
	const consumer = openSync(output, "r");
	try {
		const result = spawnSync(process.execPath, [join(import.meta.dirname, "build-procward-transport.mjs"), output], {
			encoding: "utf8", timeout: 125000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readFileSync(consumer), previous, "publishing must not truncate or overwrite an inode used by a live consumer");
		assert.notDeepEqual(readFileSync(output), previous, "new consumers must get the completed replacement");
	} finally {
		closeSync(consumer);
		rmSync(work, { recursive: true, force: true });
	}
});
