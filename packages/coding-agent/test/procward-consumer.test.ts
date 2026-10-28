import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const resolver = fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/procward-consumer.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/procward-consumer.py", import.meta.url));
const python = process.platform === "freebsd" ? "python3.11" : "python3";
beforeAll(() => {
	execFileSync(process.execPath, ["scripts/build-procward-transport.mjs"], { cwd: root, timeout: 120000 });
}, 125000);

function run(mode: string): { code: number; seconds: number; stdout: string; stderr: string; parentAlive: boolean } {
	return JSON.parse(
		execFileSync(python, [fixture, process.execPath, resolver, probe, mode], { encoding: "utf8", timeout: 18000 }),
	);
}
describe("managed-child boundary with a live native parent", () => {
	it.each([
		"wrong-primary",
		"wrong-owner",
		"wrong-launch",
		"wrong-version",
		"wrong-identity",
		"extra-field",
		"oversized",
		"non-ascii",
		"eof-before",
		"silence",
		"partial",
	])(
		"rejects %s before readiness",
		(mode) => {
			const result = run(mode);
			expect(result.code).not.toBe(0);
			expect(result.stdout).not.toContain('"ready":true');
			expect(result.seconds).toBeLessThan(5);
		},
		20000,
	);
	it.each(["notice", "invalid-notice", "eof-after"])(
		"observes %s, not a TERM or dead-parent substitute",
		(mode) => {
			const result = run(mode);
			expect(result.parentAlive).toBe(true);
			expect(result.code).toBe(mode === "notice" ? 0 : 125);
			const [ready, loss] = result.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(ready.metadata).toEqual([]);
			if (process.platform === "linux") expect(Number.parseInt(ready.flags, 8) & 0o2000000).not.toBe(0);
			expect(loss.loss).toBe(true);
		},
		20000,
	);
	it.each(["startup-term", "print-notice", "rpc-notice"])(
		"retains ordinary noninteractive TERM semantics (%s)",
		(mode) => {
			const result = run(mode);
			expect(result.code).not.toBe(0);
			expect(result.seconds).toBeLessThan(5);
			expect(result.stdout.trim().split("\n")).toHaveLength(1);
		},
		20000,
	);
	it("enforces notice-driven 7s bound while main JS blocks and parent lives", () => {
		const result = run("blocked");
		expect(result.parentAlive).toBe(true);
		expect(result.code).not.toBe(0);
		expect(result.seconds).toBeGreaterThanOrEqual(7);
		expect(result.seconds).toBeLessThan(10);
	}, 20000);
});
