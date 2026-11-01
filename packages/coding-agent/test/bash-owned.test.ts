import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { createLocalBashOperations, createLocalShellOperations } from "../src/core/tools/bash.ts";
import { killTrackedDetachedChildren } from "../src/utils/shell.ts";

const binary = process.env.PI_PROCESS_OWNER_TEST_BINARY;
const fixture = fileURLToPath(new URL("./fixtures/owned-shell.mjs", import.meta.url));
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
};

// Source integration requires a built Linux helper; skipped input is never release evidence.
describe.skipIf(!binary || process.platform !== "linux")("native-owned local shell operations", () => {
	for (const mode of ["exit", "cancel", "timeout", "tracked-stop", "stdin"] as const) {
		it(`cleans detached descendants before ${mode} settlement`, async () => {
			const directory = mkdtempSync(join(tmpdir(), "bash-owned-"));
			const marker = join(directory, "descendant");
			const previous = process.env.PI_PROCESS_OWNER_BINARY;
			process.env.PI_PROCESS_OWNER_BINARY = binary;
			const peer = spawn(process.execPath, ["-e", "setTimeout(()=>{},12000)"], { stdio: "ignore" });
			const peerDone = new Promise((resolve) => peer.once("exit", resolve));
			const controller = new AbortController();
			const operations =
				mode === "stdin"
					? createLocalShellOperations("sh", () => ({ shell: "/bin/sh", args: ["-s"], commandTransport: "stdin" }))
					: createLocalBashOperations();
			const command = `exec ${quote(process.execPath)} ${quote(fixture)} ${quote(marker)} ${mode === "stdin" ? "exit" : mode}`;
			let output = "";
			const settled = operations
				.exec(command, directory, {
					onData: (data) => {
						output += data.toString();
					},
					signal: controller.signal,
					timeout: mode === "timeout" ? 1 : 5,
				})
				.then(
					(result) => ({ result, error: undefined }),
					(error: unknown) => ({ result: undefined, error }),
				);
			try {
				const deadline = Date.now() + 2500;
				while (!existsSync(marker) || !output.includes("\n")) {
					assert.ok(Date.now() < deadline, "fixture did not become ready");
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				const descendant = Number(readFileSync(marker, "utf8"));
				if (mode === "cancel") controller.abort();
				if (mode === "tracked-stop") killTrackedDetachedChildren();
				const outcome = await settled;
				assert.ok(!alive(descendant), "detached descendant survived task settlement");
				assert.ok(alive(peer.pid!), "cleanup killed independent peer");
				if (mode === "cancel") assert.match(String(outcome.error), /aborted/);
				else if (mode === "timeout") assert.match(String(outcome.error), /timeout:1/);
				else {
					assert.equal(outcome.error, undefined);
					assert.equal(outcome.result?.exitCode, mode === "tracked-stop" ? 137 : 0);
				}
				assert.match(output, new RegExp(`^${descendant}\\n`));
			} finally {
				controller.abort();
				await settled;
				peer.kill("SIGKILL");
				await peerDone;
				if (previous === undefined) delete process.env.PI_PROCESS_OWNER_BINARY;
				else process.env.PI_PROCESS_OWNER_BINARY = previous;
				rmSync(directory, { recursive: true, force: true });
			}
		}, 7000);
	}
});
