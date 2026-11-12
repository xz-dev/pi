import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";

// These fixtures exercise only pi's observer. They never run procward or kill
// another process tree; Linux procward runtime tests belong in its VM runner.
const observerModule = new URL("../src/utils/managed-child.ts", import.meta.url).href;
const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-owner-watchdog-"));
	directories.push(directory);
	return directory;
}

async function runObserverFixture(
	source: string,
	closeOnStart = false,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
	const directory = fixtureDirectory();
	const script = join(directory, "observer.mjs");
	writeFileSync(script, source);
	const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
		if (closeOnStart && output.includes("STARTED\n")) {
			const lifecycle = child.stdio[3];
			if (lifecycle instanceof Duplex) lifecycle.end();
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	const guard = setTimeout(() => child.kill("SIGKILL"), 11_000);
	try {
		const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve({ code, signal }));
		});
		return { ...result, output };
	} finally {
		clearTimeout(guard);
	}
}

describe.skipIf(process.platform === "win32")("pi owner-loss watchdog", () => {
	test("reports EOF from the inherited lifecycle pipe", async () => {
		const result = await runObserverFixture(
			`
import { observeOwnerLoss } from ${JSON.stringify(observerModule)};
observeOwnerLoss({ ownerPid: process.ppid, launchId: "a".repeat(32), lifecycleFd: 3 }, reason => {
 process.stdout.write(reason + "\\n");
 process.exit(0);
});
process.stdout.write("STARTED\\n");
setInterval(() => {}, 1000);
`,
			true,
		);
		expect(result).toEqual({ code: 0, signal: null, output: "STARTED\neof\n" });
	});

	test("does not terminate a healthy session after seven seconds", async () => {
		const result = await runObserverFixture(`
import { observeOwnerLoss } from ${JSON.stringify(observerModule)};
observeOwnerLoss({ ownerPid: process.ppid, launchId: "a".repeat(32), lifecycleFd: 3 }, () => {
 process.stdout.write("UNEXPECTED LOSS\\n");
 process.exit(2);
});
setTimeout(() => { process.stdout.write("HEALTHY\\n"); process.exit(0); }, 7800);
`);
		expect(result, "a healthy observer must not arm the fatal deadline").toEqual({
			code: 0,
			signal: null,
			output: "HEALTHY\n",
		});
	}, 15_000);

	test("terminates within seven seconds of loss even when the main loop blocks", async () => {
		const startedAt = Date.now();
		const result = await runObserverFixture(
			`
import { observeOwnerLoss } from ${JSON.stringify(observerModule)};
observeOwnerLoss({ ownerPid: process.ppid, launchId: "a".repeat(32), lifecycleFd: 3 }, () => {
 process.stdout.write("LOSS\\n");
 while (true) {}
});
process.stdout.write("STARTED\\n");
setInterval(() => {}, 1000);
`,
			true,
		);
		expect(result.output).toBe("STARTED\nLOSS\n");
		expect(result.signal).toBe("SIGKILL");
		// Allow process startup/CI scheduling time, but not the 11-second guard.
		expect(Date.now() - startedAt).toBeLessThan(9500);
	}, 15_000);
});
