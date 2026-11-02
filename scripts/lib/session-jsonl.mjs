// Read logical JSONL bytes from plain files or standard concatenated Zstandard frames.
import { constants as bufferConstants } from "node:buffer";
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

export function readSessionJsonlBytes(path) {
	const bytes = readFileSync(path);
	const magic = bytes.length >= 4 ? bytes.readUInt32LE(0) : undefined;
	return magic === 0xfd2fb528 || (magic !== undefined && (magic & 0xfffffff0) === 0x184d2a50)
		? zstdDecompressSync(bytes, { maxOutputLength: bufferConstants.MAX_STRING_LENGTH })
		: bytes;
}
