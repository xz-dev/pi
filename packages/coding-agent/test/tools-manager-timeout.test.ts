import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getToolPath } from "../src/utils/tools-manager.ts";

const originalPath = process.env.PATH;

afterEach(() => {
	process.env.PATH = originalPath;
});

describe("tool discovery", () => {
	it.skipIf(process.platform === "win32")("bounds system command version probes", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-tool-probe-"));
		try {
			const fd = join(root, "fd");
			writeFileSync(fd, "#!/bin/sh\nwhile :; do :; done\n");
			chmodSync(fd, 0o755);
			process.env.PATH = root;

			const started = performance.now();
			expect(getToolPath("fd")).toBeNull();
			expect(performance.now() - started).toBeLessThan(2_000);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
