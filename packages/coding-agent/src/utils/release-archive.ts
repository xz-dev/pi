import { crc32, inflateRawSync } from "node:zlib";

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP_UNIX_MODE = 0o100755;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;

/**
 * Extract the executable from an xz-dev release ZIP: exactly one deflated
 * `entryName` entry (mode 0755), no comment, extra fields, data descriptor or
 * bytes outside the entry. Any other shape throws, so a tampered archive can
 * never inflate to an unexpected file or size.
 */
export function readReleaseArchive(archive: Uint8Array, entryName: string, label: string): Buffer {
	const fail = (reason: string): never => {
		throw new Error(`${label} ${reason}`);
	};
	const zip = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
	const name = Buffer.from(entryName, "utf8");
	if (zip.length < LOCAL_HEADER + CENTRAL_HEADER + END_RECORD + 2 * name.length) return fail("is truncated");
	const endOffset = zip.length - END_RECORD;
	if (zip.readUInt32LE(endOffset) !== ZIP_END || zip.readUInt16LE(endOffset + 20) !== 0) {
		return fail("has no plain end record");
	}
	if (
		zip.readUInt16LE(endOffset + 4) !== 0 ||
		zip.readUInt16LE(endOffset + 6) !== 0 ||
		zip.readUInt16LE(endOffset + 8) !== 1 ||
		zip.readUInt16LE(endOffset + 10) !== 1
	) {
		return fail("must contain exactly one entry");
	}
	const centralSize = zip.readUInt32LE(endOffset + 12);
	const centralOffset = zip.readUInt32LE(endOffset + 16);
	if (centralSize !== CENTRAL_HEADER + name.length || centralOffset + centralSize !== endOffset) {
		return fail("central directory is malformed");
	}
	const central = zip.subarray(centralOffset, endOffset);
	if (central.readUInt32LE(0) !== ZIP_CENTRAL || central.readUInt16LE(8) !== 0 || central.readUInt16LE(10) !== 8) {
		return fail("entry must be plain deflate");
	}
	if (
		central.readUInt16LE(28) !== name.length ||
		central.readUInt16LE(30) !== 0 ||
		central.readUInt16LE(32) !== 0 ||
		central.readUInt32LE(42) !== 0
	) {
		return fail("central entry layout is unexpected");
	}
	if (!central.subarray(CENTRAL_HEADER).equals(name)) return fail(`must contain only ${entryName}`);
	const checksum = central.readUInt32LE(16);
	const compressedSize = central.readUInt32LE(20);
	const size = central.readUInt32LE(24);
	if (central.readUInt32LE(38) >>> 16 !== ZIP_UNIX_MODE) return fail(`${entryName} must be a 0755 regular file`);
	if (
		zip.readUInt32LE(0) !== ZIP_LOCAL ||
		zip.readUInt16LE(6) !== 0 ||
		zip.readUInt16LE(8) !== 8 ||
		zip.readUInt16LE(26) !== name.length ||
		zip.readUInt16LE(28) !== 0
	) {
		return fail("local entry layout is unexpected");
	}
	if (zip.readUInt32LE(14) !== checksum || zip.readUInt32LE(18) !== compressedSize || zip.readUInt32LE(22) !== size) {
		return fail("local and central entries disagree");
	}
	if (!zip.subarray(LOCAL_HEADER, LOCAL_HEADER + name.length).equals(name))
		return fail(`must contain only ${entryName}`);
	const dataStart = LOCAL_HEADER + name.length;
	if (dataStart + compressedSize !== centralOffset) return fail("has bytes outside the entry");
	const body = inflateRawSync(zip.subarray(dataStart, centralOffset), { maxOutputLength: size });
	if (body.length !== size || crc32(body) !== checksum) return fail(`${entryName} failed size or CRC verification`);
	return body;
}
