// Read logical JSONL bytes from plain files or standard concatenated Zstandard frames.
import { constants as bufferConstants } from "node:buffer";
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

export function readSessionJsonlBytes(path, maxOutputLength = bufferConstants.MAX_STRING_LENGTH) {
	const bytes = readFileSync(path);
	const magic = bytes.length >= 4 ? bytes.readUInt32LE(0) : undefined;
	if (magic !== 0xfd2fb528 && !(magic !== undefined && (magic & 0xfffffff0) === 0x184d2a50)) return bytes;
	const parts = [];
	let offset = 0;
	let total = 0;
	while (offset < bytes.length) {
		const start = offset;
		offset = frameEnd(bytes, start);
		if (bytes.readUInt32LE(start) !== 0xfd2fb528) continue;
		const part = zstdDecompressSync(bytes.subarray(start, offset), { maxOutputLength: Math.max(1, maxOutputLength - total) });
		total += part.length;
		if (total > maxOutputLength) throw new Error("Zstandard output exceeds maximum length");
		parts.push(part);
	}
	return Buffer.concat(parts, total);
}

function invalid() {
	throw new Error("Invalid or truncated Zstandard frame");
}

// Standalone artifact verification cannot import the packaged product codec.
function frameEnd(bytes, start) {
	let offset = start;
	if (offset + 4 > bytes.length) invalid();
	const magic = bytes.readUInt32LE(offset);
	offset += 4;
	if ((magic & 0xfffffff0) === 0x184d2a50) {
		if (offset + 4 > bytes.length) invalid();
		const end = offset + 4 + bytes.readUInt32LE(offset);
		if (end > bytes.length) invalid();
		return end;
	}
	if (magic !== 0xfd2fb528 || offset >= bytes.length) invalid();
	const descriptor = bytes[offset++];
	if (descriptor & 8) invalid();
	const singleSegment = (descriptor & 32) !== 0;
	const contentSizeFlag = descriptor >>> 6;
	const dictionarySize = [0, 1, 2, 4][descriptor & 3];
	const contentSize = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
	offset += (singleSegment ? 0 : 1) + dictionarySize + contentSize;
	let last = false;
	while (!last) {
		if (offset + 3 > bytes.length) invalid();
		const header = bytes.readUIntLE(offset, 3);
		const type = (header >>> 1) & 3;
		if (type === 3) invalid();
		last = (header & 1) !== 0;
		offset += 3 + (type === 1 ? 1 : header >>> 3);
		if (offset > bytes.length) invalid();
	}
	if (descriptor & 4) offset += 4;
	if (offset > bytes.length) invalid();
	return offset;
}
