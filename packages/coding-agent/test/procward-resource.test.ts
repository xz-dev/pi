import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPackagedProcward, getProcwardTransport } from "../src/config.ts";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function packageRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-procward-resource-"));
	roots.push(root);
	vi.stubEnv("PI_PACKAGE_DIR", root);
	return root;
}

describe("packaged procward resources", () => {
	it("allows source installs without a supplied helper", () => {
		packageRoot();
		expect(getPackagedProcward()).toBeUndefined();
	});
	it("rejects missing or mismatched supplied bytes rather than trying PATH", () => {
		const root = packageRoot();
		const dir = join(root, "dist", "native", "procward");
		mkdirSync(dir, { recursive: true });
		expect(getPackagedProcward).toThrow();
		const binary = join(dir, process.platform === "win32" ? "procward.exe" : "procward");
		writeFileSync(binary, "verified helper");
		writeFileSync(
			join(dir, "pin.json"),
			JSON.stringify({
				state: "unpinned-dev",
				version: "0.1.0",
				binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
			}),
		);
		expect(getPackagedProcward()).toBe(binary);
		writeFileSync(binary, "tampered");
		expect(getPackagedProcward).toThrow("digest mismatch");
	});
	it("requires the native consumer adapter as a physical package resource", () => {
		const root = packageRoot();
		expect(getProcwardTransport).toThrow();
		const dir = join(root, "dist", "native", "procward-transport");
		mkdirSync(dir, { recursive: true });
		const addon = join(dir, "procward-transport.node");
		writeFileSync(addon, "adapter");
		expect(getProcwardTransport()).toBe(addon);
	});
});
