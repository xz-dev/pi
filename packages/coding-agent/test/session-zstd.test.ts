import { constants, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decompressSessionZstd, decompressSessionZstdFrame } from "../src/core/session-zstd.ts";

const first = Buffer.from("first 漢字\r\n");
const second = Buffer.from("second\n");
const frame = (text: Buffer) => zstdCompressSync(text, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
const skip = Buffer.from([0x5f, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3]);

describe("complete Zstandard frame decoding", () => {
	it("preserves exact concatenated bytes through leading, interleaved and trailing skippable frames", () => {
		const bytes = Buffer.concat([skip, frame(first), skip, frame(second), skip]);
		expect(decompressSessionZstd(bytes)).toEqual(Buffer.concat([first, second]));
		expect(decompressSessionZstdFrame(frame(first))).toEqual(first);
		for (const bytes of [skip, Buffer.concat([frame(first), frame(second)]), Buffer.concat([frame(first), skip])])
			expect(() => decompressSessionZstdFrame(bytes)).toThrow();
	});

	it("rejects every nonempty truncated prefix, including final checksum and skippable boundaries", () => {
		for (const complete of [frame(first), zstdCompressSync(first), skip]) {
			for (let cut = 1; cut < complete.length; cut++) {
				expect(() => decompressSessionZstd(complete.subarray(0, cut))).toThrow();
				expect(() => decompressSessionZstd(Buffer.concat([frame(second), complete.subarray(0, cut)]))).toThrow();
			}
		}
	});

	it("rejects checksum corruption, invalid blocks, reserved flags and trailing garbage", () => {
		const corrupt = frame(first);
		corrupt[corrupt.length - 1] ^= 1;
		const reserved = frame(first);
		reserved[4] |= 8;
		const badBlock = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0, 7, 0, 0]);
		for (const bytes of [corrupt, reserved, badBlock, Buffer.concat([frame(first), Buffer.from("junk")])])
			expect(() => decompressSessionZstd(bytes)).toThrow();
	});

	it("bounds aggregate output, not each frame separately, including exhausted limits", () => {
		const bytes = Buffer.concat([frame(first), skip, frame(second)]);
		const length = first.length + second.length;
		expect(decompressSessionZstd(bytes, length)).toEqual(Buffer.concat([first, second]));
		expect(() => decompressSessionZstd(bytes, length - 1)).toThrow();
		expect(() => decompressSessionZstd(bytes, first.length)).toThrow();
		expect(decompressSessionZstd(frame(Buffer.alloc(0)), 0)).toEqual(Buffer.alloc(0));
		expect(() => decompressSessionZstd(frame(first), 0)).toThrow();
	});
});
