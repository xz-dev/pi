import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const VERSION = "0.84.1-xz.88.1.g9a4c0822";
const TAG = `xz-v${VERSION}`;
const X64_HASH = "a".repeat(64);
const ARM64_HASH = "b".repeat(64);

test("creates Scoop manifest for Windows x64 modern and arm64", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-scoop-"));
	try {
		const manifestPath = join(directory, "release-manifest.json");
		const outputPath = join(directory, "pi.json");
		writeFileSync(
			manifestPath,
			`${JSON.stringify({
				distributionVersion: VERSION,
				tag: TAG,
				bundles: {
					"windows-x64-modern": { file: "pi-windows-x64-modern.zip", sha256: X64_HASH },
					"windows-arm64": { file: "pi-windows-arm64.zip", sha256: ARM64_HASH },
				},
				attestation: { subjectsFile: "attestation-subjects.jsonl" },
			})}\n`,
		);
		execFileSync(process.execPath, [join(import.meta.dirname, "create-scoop-manifest.mjs"), manifestPath, outputPath]);

		const scoop = JSON.parse(readFileSync(outputPath, "utf8"));
		assert.equal(scoop.version, VERSION);
		assert.equal(scoop.bin, "pi.exe");
		assert.deepEqual(scoop.architecture["64bit"], {
			url: `https://github.com/xz-dev/pi/releases/download/${TAG}/pi-windows-x64-modern.zip`,
			hash: X64_HASH,
		});
		assert.deepEqual(scoop.architecture.arm64, {
			url: `https://github.com/xz-dev/pi/releases/download/${TAG}/pi-windows-arm64.zip`,
			hash: ARM64_HASH,
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
