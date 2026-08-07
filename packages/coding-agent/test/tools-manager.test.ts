import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getToolPath } from "../src/utils/tools-manager.ts";

const originalPath = process.env.PATH;

afterEach(() => {
	process.env.PATH = originalPath;
});

describe("tool discovery", () => {
	it("bounds system command version probes", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-tool-probe-"));
		try {
			const fd = join(root, process.platform === "win32" ? "fd.cmd" : "fd");
			writeFileSync(fd, process.platform === "win32" ? "@ping -n 11 127.0.0.1 >nul\r\n" : "#!/bin/sh\nsleep 10\n");
			chmodSync(fd, 0o755);
			process.env.PATH = `${root}${delimiter}${originalPath ?? ""}`;

			const started = performance.now();
			expect(getToolPath("fd")).toBeNull();
			expect(performance.now() - started).toBeLessThan(2_000);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
