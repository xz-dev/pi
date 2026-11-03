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
		for (const completeFrame of [complete, zstdCompressSync(Buffer.from("unchecked transcript"))]) {
			for (let cut = 4; cut < completeFrame.length; cut++) {
				const path = join(root, "truncated.jsonl");
				writeFileSync(path, completeFrame.subarray(0, cut));
				assert.throws(() => readSessionJsonlBytes(path));
				writeFileSync(path, Buffer.concat([complete, completeFrame.subarray(0, cut)]));
				assert.throws(() => readSessionJsonlBytes(path));
			}
		}
		const skip = Buffer.from([0x5f, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3]);
		for (let cut = 1; cut < skip.length; cut++) {
			const path = join(root, "skip.jsonl");
			writeFileSync(path, Buffer.concat([complete, skip.subarray(0, cut)]));
			assert.throws(() => readSessionJsonlBytes(path));
		}
		const reserved = Buffer.from(complete);
		reserved[4] |= 8;
		const invalidBlock = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0, 7, 0, 0]);
		for (const bytes of [corrupt, complete.subarray(0, 8), incompleteSkip, Buffer.concat([complete, corrupt]), reserved, invalidBlock, Buffer.concat([complete, Buffer.from("junk")])]) {
			const path = join(root, "bad.jsonl");
			writeFileSync(path, bytes);
			assert.throws(() => readSessionJsonlBytes(path));
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("session smoke reader bounds aggregate output across frames and exhausted limits", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-session-reader-bound-"));
	try {
		const path = join(root, "bounded.jsonl");
		const first = Buffer.from("first");
		const second = Buffer.from("second");
		writeFileSync(path, Buffer.concat([zstdCompressSync(first), zstdCompressSync(second)]));
		assert.deepEqual(readSessionJsonlBytes(path, first.length + second.length), Buffer.concat([first, second]));
		assert.throws(() => readSessionJsonlBytes(path, first.length + second.length - 1));
		assert.throws(() => readSessionJsonlBytes(path, first.length));
		assert.throws(() => readSessionJsonlBytes(path, 0));
		writeFileSync(path, zstdCompressSync(Buffer.alloc(0)));
		assert.deepEqual(readSessionJsonlBytes(path, 0), Buffer.alloc(0));
	} finally { rmSync(root, { recursive: true, force: true }); }
});
