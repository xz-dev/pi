// Independent standard-decoder oracle: Node 22 reports consumed input but stops after each frame.
import { zstdDecompressSync } from "node:zlib";

export function decodeStandardZstd(bytes: Buffer): Buffer {
	const parts: Buffer[] = [];
	while (bytes.length) {
		// Node's runtime supports info:true, but @types/node omits its Zstandard return overload.
		const { buffer, engine } = zstdDecompressSync(bytes, { info: true }) as unknown as {
			buffer: Buffer;
			engine: { bytesWritten: number };
		};
		if (engine.bytesWritten <= 0 || engine.bytesWritten > bytes.length) throw new Error("Decoder made no progress");
		parts.push(buffer);
		bytes = bytes.subarray(engine.bytesWritten);
	}
	return Buffer.concat(parts);
}
