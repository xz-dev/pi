// Append-only Zstandard session transactions with plaintext browsing metadata.
import { constants as bufferConstants } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fchmodSync,
	fsyncSync,
	futimesSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { FileEntry, SessionHeader, SessionInfo } from "./session-manager.ts";

export interface CompressedSessionMetadata {
	header: SessionHeader;
	name?: string;
	messageCount: number;
	firstMessage: string;
	activity?: number;
}

export interface CompressedSessionState {
	metadata: CompressedSessionMetadata;
	committedBytes: number;
	incompleteTail: boolean;
	transactions: number;
	format: "transactions" | "zstd";
}

const SKIP_MAGIC = 0x184d2a50;
const DESCRIPTOR_SIZE = 112;
const MAX_METADATA_BYTES = 1024 * 1024;
const TAG = Buffer.from("PISESS01");

function digest(bytes: Uint8Array): Buffer {
	return createHash("sha256").update(bytes).digest();
}

/** Detect compression by bytes, including standard zstd input and partial pi framing. */
export function isCompressedSession(path: string): boolean {
	if (!existsSync(path)) return false;
	const fd = openSync(path, "r");
	try {
		const magic = Buffer.alloc(4);
		const size = readSync(fd, magic, 0, 4, 0);
		if (!size) return false;
		const piMagic = Buffer.from([0x50, 0x2a, 0x4d, 0x18]);
		return (
			magic.subarray(0, size).equals(piMagic.subarray(0, size)) ||
			(size === 4 && (magic.readUInt32LE() === 0xfd2fb528 || (magic.readUInt32LE() & 0xfffffff0) === SKIP_MAGIC))
		);
	} finally {
		closeSync(fd);
	}
}

/** Update the small browsing summary from only the newly appended entries. */
export function summarizeSession(
	entries: FileEntry[],
	previous?: CompressedSessionMetadata,
): CompressedSessionMetadata {
	const header = previous?.header ?? entries.find((entry): entry is SessionHeader => entry.type === "session");
	if (!header) throw new Error("Compressed session has no session header");
	const metadata: CompressedSessionMetadata = previous
		? { ...previous }
		: { header, messageCount: 0, firstMessage: "" };
	for (const entry of entries) {
		if (entry.type === "session_info") metadata.name = entry.name?.trim() || undefined;
		if (entry.type !== "message") continue;
		metadata.messageCount++;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const activity = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
		if (Number.isFinite(activity)) metadata.activity = Math.max(metadata.activity ?? 0, activity);
		if (!metadata.firstMessage && message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: (message.content ?? [])
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join(" ");
			metadata.firstMessage = text.slice(0, 200);
		}
	}
	return metadata;
}

/** Encode exact JSONL bytes as one independently recoverable standard zstd transaction. */
export function encodeSessionTransaction(text: string, metadata: CompressedSessionMetadata): Buffer {
	const json = Buffer.from(JSON.stringify(metadata));
	if (json.length > MAX_METADATA_BYTES) throw new Error("Session browsing metadata exceeds 1 MiB");
	parseMetadata(json, "new session transaction");
	const compressed = zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
	if (compressed.length > 0xffffffff) throw new Error("Session transaction exceeds 4 GiB");
	// Fixed-size descriptor protects both variable lengths before readers trust them.
	const descriptor = Buffer.alloc(8 + DESCRIPTOR_SIZE);
	descriptor.writeUInt32LE(SKIP_MAGIC, 0);
	descriptor.writeUInt32LE(DESCRIPTOR_SIZE, 4);
	TAG.copy(descriptor, 8);
	descriptor.writeUInt32LE(json.length, 16);
	descriptor.writeUInt32LE(compressed.length, 20);
	digest(json).copy(descriptor, 24);
	digest(compressed).copy(descriptor, 56);
	digest(descriptor.subarray(0, 88)).copy(descriptor, 88);
	const metadataFrame = Buffer.alloc(8);
	metadataFrame.writeUInt32LE(SKIP_MAGIC + 1, 0);
	metadataFrame.writeUInt32LE(json.length, 4);
	return Buffer.concat([descriptor, metadataFrame, json, compressed]);
}

function invalid(path: string): never {
	throw new Error(`Invalid compressed session: ${path}`);
}

function parseMetadata(bytes: Buffer, path: string): CompressedSessionMetadata {
	// Disk is a trust boundary; framing checks alone do not validate JSON metadata.
	const value: unknown = JSON.parse(bytes.toString("utf8"));
	if (!value || typeof value !== "object") return invalid(path);
	const m = value as CompressedSessionMetadata;
	if (
		!m.header ||
		m.header.type !== "session" ||
		typeof m.header.id !== "string" ||
		(m.header.cwd !== undefined && typeof m.header.cwd !== "string") ||
		typeof m.header.timestamp !== "string" ||
		!Number.isFinite(Date.parse(m.header.timestamp)) ||
		(m.header.parentSession !== undefined && typeof m.header.parentSession !== "string") ||
		(m.header.version !== undefined && (!Number.isSafeInteger(m.header.version) || m.header.version < 1)) ||
		typeof m.firstMessage !== "string" ||
		m.firstMessage.length > 200 ||
		(m.name !== undefined && typeof m.name !== "string") ||
		!Number.isSafeInteger(m.messageCount) ||
		m.messageCount < 0 ||
		(m.activity !== undefined && (!Number.isFinite(m.activity) || Math.abs(m.activity) > 8.64e15))
	)
		return invalid(path);
	return m;
}

function scanCompressed(bytes: Buffer, path: string, onText?: (text: string) => void): CompressedSessionState {
	let offset = 0;
	let metadata: CompressedSessionMetadata | undefined;
	let verifiedMetadata: CompressedSessionMetadata | undefined;
	let transactions = 0;
	while (offset < bytes.length) {
		const remaining = bytes.subarray(offset);
		if (remaining.length < 120) {
			const prefix = Buffer.alloc(16);
			prefix.writeUInt32LE(SKIP_MAGIC, 0);
			prefix.writeUInt32LE(DESCRIPTOR_SIZE, 4);
			TAG.copy(prefix, 8);
			if (
				!remaining
					.subarray(0, Math.min(16, remaining.length))
					.equals(prefix.subarray(0, Math.min(16, remaining.length)))
			)
				return invalid(path);
			break;
		}
		const descriptor = remaining.subarray(0, 120);
		if (
			descriptor.readUInt32LE(0) !== SKIP_MAGIC ||
			descriptor.readUInt32LE(4) !== DESCRIPTOR_SIZE ||
			!descriptor.subarray(8, 16).equals(TAG) ||
			!digest(descriptor.subarray(0, 88)).equals(descriptor.subarray(88, 120))
		)
			return invalid(path);
		const metadataLength = descriptor.readUInt32LE(16);
		const payloadLength = descriptor.readUInt32LE(20);
		if (metadataLength < 2 || metadataLength > MAX_METADATA_BYTES || payloadLength < 4) return invalid(path);
		if (remaining.length < 128) {
			const frame = Buffer.alloc(8);
			frame.writeUInt32LE(SKIP_MAGIC + 1, 0);
			frame.writeUInt32LE(metadataLength, 4);
			if (!remaining.subarray(120).equals(frame.subarray(0, remaining.length - 120))) return invalid(path);
			break;
		}
		if (remaining.readUInt32LE(120) !== SKIP_MAGIC + 1 || remaining.readUInt32LE(124) !== metadataLength)
			return invalid(path);
		if (remaining.length < 128 + metadataLength) break;
		const json = remaining.subarray(128, 128 + metadataLength);
		if (!digest(json).equals(descriptor.subarray(24, 56))) return invalid(path);
		const next = parseMetadata(json, path);
		if (metadata && JSON.stringify(metadata.header) !== JSON.stringify(next.header)) return invalid(path);
		if (metadata && next.messageCount < metadata.messageCount) return invalid(path);
		const size = 128 + metadataLength + payloadLength;
		if (remaining.length < size) break;
		const payload = remaining.subarray(128 + metadataLength, size);
		if (payload.readUInt32LE(0) !== 0xfd2fb528 || !digest(payload).equals(descriptor.subarray(56, 88)))
			return invalid(path);
		if (onText) {
			const text = zstdDecompressSync(payload, { maxOutputLength: bufferConstants.MAX_STRING_LENGTH }).toString(
				"utf8",
			);
			const entries: FileEntry[] = [];
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				try {
					const value: unknown = JSON.parse(line);
					if (value && typeof value === "object" && "type" in value) entries.push(value as FileEntry);
				} catch {
					/* Preserve the plain reader's malformed-line handling. */
				}
			}
			if (
				!metadata &&
				(entries[0]?.type !== "session" || JSON.stringify(entries[0]) !== JSON.stringify(next.header))
			)
				return invalid(path);
			if (metadata && entries.some((entry) => entry.type === "session")) return invalid(path);
			verifiedMetadata = summarizeSession(entries, verifiedMetadata);
			if (JSON.stringify(verifiedMetadata) !== JSON.stringify(next)) return invalid(path);
			onText(text);
		}
		metadata = next;
		offset += size;
		transactions++;
	}
	if (!metadata) return invalid(path);
	return {
		metadata,
		committedBytes: offset,
		incompleteTail: offset !== bytes.length,
		transactions,
		format: "transactions",
	};
}

/** Read committed transactions; incomplete EOF tails are never repaired by readers. */
export function readCompressedSession(path: string, onText?: (text: string) => void): CompressedSessionState {
	const bytes = readFileSync(path);
	if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0xfd2fb528) {
		const text = zstdDecompressSync(bytes, { maxOutputLength: bufferConstants.MAX_STRING_LENGTH }).toString("utf8");
		const entries: FileEntry[] = [];
		for (const line of text.split("\n")) {
			try {
				entries.push(JSON.parse(line) as FileEntry);
			} catch {
				/* Match ordinary JSONL parsing. */
			}
		}
		if (entries[0]?.type !== "session" || typeof entries[0].id !== "string") return invalid(path);
		const metadata = summarizeSession(entries);
		onText?.(text);
		return { metadata, committedBytes: bytes.length, incompleteTail: false, transactions: 1, format: "zstd" };
	}
	const state = scanCompressed(bytes, path, onText);
	if (state.incompleteTail) {
		// Verify every committed frame before treating any EOF tail as recoverable.
		if (!onText) scanCompressed(bytes.subarray(0, state.committedBytes), path, () => {});
		console.error(
			`Warning: Incomplete session append in ${path}; reading committed history only. The next write will repair the tail.`,
		);
	}
	return state;
}

/** Publish a complete replacement without exposing a truncated source or permissive temporary file. */
export function replaceSessionFile(path: string, bytes: Uint8Array, preserveTimes = false): void {
	const destination = existsSync(path) ? realpathSync(path) : path;
	const temp = `${destination}.${randomUUID()}.tmp`;
	const previous = existsSync(destination) ? statSync(destination) : undefined;
	let created = false;
	try {
		const fd = openSync(temp, "wx", previous ? previous.mode & 0o777 : 0o600);
		created = true;
		try {
			writeFileSync(fd, bytes);
			if (previous) fchmodSync(fd, previous.mode & 0o777);
			if (preserveTimes && previous) futimesSync(fd, previous.atime, previous.mtime);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, destination);
		if (process.platform !== "win32") {
			let directory: number | undefined;
			try {
				directory = openSync(dirname(destination), "r");
				fsyncSync(directory);
			} catch {
				/* Directory fsync is not supported on every filesystem. */
			} finally {
				if (directory !== undefined) closeSync(directory);
			}
		}
	} finally {
		if (created && existsSync(temp)) unlinkSync(temp);
	}
}

/** Append only new compressed data; recover an interrupted append atomically on the rare repair path. */
export function appendCompressedSession(
	path: string,
	text: string,
	entries: FileEntry[],
	state: CompressedSessionState,
): CompressedSessionState {
	const metadata = summarizeSession(entries, state.metadata);
	// A separator also permits appending to imported JSONL without a final newline.
	const transaction = encodeSessionTransaction(`\n${text}`, metadata);
	if (state.format === "zstd") {
		let previous = "";
		readCompressedSession(path, (part) => {
			previous += part;
		});
		const bytes = encodeSessionTransaction(`${previous}\n${text}`, metadata);
		replaceSessionFile(path, bytes);
		return { metadata, committedBytes: bytes.length, incompleteTail: false, transactions: 1, format: "transactions" };
	}
	if (state.incompleteTail || statSync(path).size !== state.committedBytes) {
		const current = readCompressedSession(path, () => {});
		if (current.committedBytes !== state.committedBytes || !current.incompleteTail)
			throw new Error(`Session changed before append: ${path}`);
		const prefix = readFileSync(path).subarray(0, current.committedBytes);
		replaceSessionFile(path, Buffer.concat([prefix, transaction]));
	} else {
		appendFileSync(path, transaction);
	}
	return {
		metadata,
		committedBytes: state.committedBytes + transaction.length,
		incompleteTail: false,
		transactions: state.transactions + 1,
		format: "transactions",
	};
}

/** Build browsing information without decoding transcript text; search text is decoded on demand. */
export function compressedSessionInfo(
	path: string,
	transcript: () => Pick<SessionInfo, "allMessagesText" | "firstMessage">,
): SessionInfo {
	const { metadata: m } = readCompressedSession(path);
	let content: Pick<SessionInfo, "allMessagesText" | "firstMessage"> | undefined;
	return {
		path,
		id: m.header.id,
		cwd: m.header.cwd ?? "",
		name: m.name,
		parentSessionPath: m.header.parentSession,
		created: new Date(m.header.timestamp),
		modified: new Date(m.activity && m.activity > 0 ? m.activity : m.header.timestamp),
		messageCount: m.messageCount,
		firstMessagePreview: m.firstMessage || "(no messages)",
		get firstMessage() {
			content ??= transcript();
			return content.firstMessage;
		},
		get allMessagesText() {
			content ??= transcript();
			return content.allMessagesText;
		},
	};
}
