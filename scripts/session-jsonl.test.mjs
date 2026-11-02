import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import test from "node:test";
import { readSessionJsonlBytes } from "./lib/session-jsonl.mjs";

test("session smoke reader preserves plain, ordinary zstd and skippable concatenated JSONL bytes", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-session-reader-"));
	try {
		const first = Buffer.from('{"type":"session","text":"Synthetic 漢字"}\r\n');
		const second = Buffer.from('{"type":"message","text":"second"}\n');
		const plain = Buffer.concat([first, second]);
		const metadata = Buffer.from('{"summary":"not transcript"}');
		const skip = Buffer.alloc(8);
		skip.writeUInt32LE(0x184d2a50, 0);
		skip.writeUInt32LE(metadata.length, 4);
		for (const bytes of [plain, zstdCompressSync(plain), Buffer.concat([zstdCompressSync(first), zstdCompressSync(second)]), Buffer.concat([skip, metadata, zstdCompressSync(first), skip, metadata, zstdCompressSync(second), skip, metadata])]) {
			const path = join(root, "native.jsonl");
			writeFileSync(path, bytes);
			assert.deepEqual(readSessionJsonlBytes(path), plain);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("session smoke reader rejects complete checksum corruption and truncated frames", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-session-reader-corrupt-"));
	try {
		const complete = zstdCompressSync(Buffer.from("synthetic transcript"), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
		const corrupt = Buffer.from(complete);
		corrupt[corrupt.length - 1] ^= 1;
		const incompleteSkip = Buffer.from([0x50, 0x2a, 0x4d, 0x18]);
		for (const bytes of [corrupt, complete.subarray(0, 8), incompleteSkip, Buffer.concat([complete, corrupt])]) {
			const path = join(root, "bad.jsonl");
			writeFileSync(path, bytes);
			assert.throws(() => readSessionJsonlBytes(path));
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});
