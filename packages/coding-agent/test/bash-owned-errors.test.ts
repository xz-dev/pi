import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { createLocalShellOperations } from "../src/core/tools/bash.ts";

const binary = process.env.PI_PROCESS_OWNER_TEST_BINARY;
// Native integration input is required; absence is not release evidence.
describe.skipIf(!binary || process.platform !== "linux")("owned shell spawn-error contract", () => {
	for (const code of ["ENOENT", "EACCES"] as const) {
		it(`preserves ${code} fields without leaking helper diagnostics into command output`, async () => {
			const directory = mkdtempSync(join(tmpdir(), "shell-error-"));
			const shell = join(directory, code === "ENOENT" ? "missing" : "not-executable");
			if (code === "EACCES") writeFileSync(shell, "not executable\n", { mode: 0o600 });
			const previous = process.env.PI_PROCESS_OWNER_BINARY;
			process.env.PI_PROCESS_OWNER_BINARY = binary;
			let output = "";
			try {
				const operations = createLocalShellOperations("review", () => ({ shell, args: ["-c"] }));
				await assert.rejects(
					operations.exec("unused", directory, {
						timeout: 2,
						onData: (data) => {
							output += data.toString();
						},
					}),
					(error: unknown) => {
						assert.ok(error instanceof Error);
						const details = error as NodeJS.ErrnoException & { path?: string; spawnargs?: string[] };
						assert.equal(details.code, code);
						assert.equal(details.errno, -constants.errno[code]);
						assert.equal(details.syscall, `spawn ${shell}`);
						assert.equal(details.path, shell);
						assert.deepEqual(details.spawnargs, ["-c", "unused"]);
						return true;
					},
				);
				assert.equal(output, "", "a failed command produced no user output");
			} finally {
				if (previous === undefined) delete process.env.PI_PROCESS_OWNER_BINARY;
				else process.env.PI_PROCESS_OWNER_BINARY = previous;
				rmSync(directory, { recursive: true, force: true });
			}
		}, 5000);
	}

	it("preserves immediate child stderr even when it resembles a helper diagnostic", async () => {
		const previous = process.env.PI_PROCESS_OWNER_BINARY;
		process.env.PI_PROCESS_OWNER_BINARY = binary;
		let output = "";
		try {
			const operations = createLocalShellOperations("node", () => ({
				shell: process.execPath,
				args: [
					"-e",
					'process.stderr.write("pi-env supervise: genuine child output\\n"); process.stdout.write("stdout\\n");',
				],
			}));
			const result = await operations.exec("unused", process.cwd(), {
				timeout: 2,
				onData: (data) => {
					output += data.toString();
				},
			});
			assert.equal(result.exitCode, 0);
			assert.ok(output.includes("pi-env supervise: genuine child output\n"));
			assert.ok(output.includes("stdout\n"));
		} finally {
			if (previous === undefined) delete process.env.PI_PROCESS_OWNER_BINARY;
			else process.env.PI_PROCESS_OWNER_BINARY = previous;
		}
	}, 5000);

	it("rejects an executable that never reports native startup", async () => {
		const previous = process.env.PI_PROCESS_OWNER_BINARY;
		process.env.PI_PROCESS_OWNER_BINARY = "/bin/true";
		try {
			const operations = createLocalShellOperations("sh", () => ({ shell: "/bin/sh", args: ["-c"] }));
			await assert.rejects(
				operations.exec("exit 0", process.cwd(), { timeout: 2, onData: () => {} }),
				/Process owner cleanup unconfirmed/,
			);
		} finally {
			if (previous === undefined) delete process.env.PI_PROCESS_OWNER_BINARY;
			else process.env.PI_PROCESS_OWNER_BINARY = previous;
		}
	}, 5000);
});
