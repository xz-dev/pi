import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const entry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const directories: string[] = [];
const launchId = "a".repeat(32);

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-cli-bootstrap-"));
	directories.push(directory);
	const loader = join(directory, "loader.mjs");
	const graph = join(directory, "imports.log");
	// Only the application is stubbed: the public entry, resolver and lifecycle reader are real.
	writeFileSync(
		loader,
		`
import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
registerHooks({ load(url, context, next) {
 appendFileSync(${JSON.stringify(graph)}, url + "\\n");
 if (url.endsWith("/src/cli/setup.ts")) return {format:"module", shortCircuit:true, source:'export function setupCli() { console.log("SETUP"); }'};
 if (url.endsWith("/src/main.ts")) return {format:"module", shortCircuit:true, source:'export async function main(args) { if (process.env.PI_ENTRY_HOLD === "1") await new Promise(resolve => setTimeout(resolve, 400)); console.log(JSON.stringify({args, nonce:process.env.PI_PROCWARD_BOOTSTRAP_NONCE, protocol:process.env.PROCWARD_PROTOCOL})); }'};
 return next(url, context);
}});
`,
	);
	const env: NodeJS.ProcessEnv = { ...process.env, PI_PACKAGE_DIR: directory, PATH: "", PI_OFFLINE: "1" };
	for (const key of Object.keys(env)) {
		if (
			key.startsWith("PROCWARD_") ||
			key === "PI_PROCWARD_BIN" ||
			key === "PI_NO_PROCESS_OWNERSHIP" ||
			key === "PI_PROCWARD_BOOTSTRAP_NONCE"
		)
			delete env[key];
	}
	return { directory, graph, env, args: ["--experimental-strip-types", "--import", loader, entry] };
}

describe.skipIf(process.platform === "win32")("real CLI bootstrap entry (Node-only peers)", () => {
	test("missing helper fails before loading setup or application dependencies", () => {
		const f = fixture();
		const result = spawnSync(process.execPath, [...f.args, "--help"], {
			env: f.env,
			encoding: "utf8",
			timeout: 6000,
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("--no-process-ownership");
		expect(result.stdout).toBe("");
		const graph = readFileSync(f.graph, "utf8");
		expect(graph).not.toMatch(/\/src\/(main|cli\/setup|core\/|modes\/)/);
		expect(graph).not.toMatch(/undici|pi-ai|pi-agent-core|pi-tui/);
	});

	test.each(["flag", "environment"])("%s opt-out ignores even an invalid helper and strips the marker", (kind) => {
		const f = fixture();
		const result = spawnSync(
			process.execPath,
			[...f.args, ...(kind === "flag" ? ["--no-process-ownership"] : []), "--help"],
			{
				env: {
					...f.env,
					PI_PROCWARD_BIN: "/missing/never-run",
					PI_PROCWARD_BOOTSTRAP_NONCE: "stale",
					...(kind === "environment" ? { PI_NO_PROCESS_OWNERSHIP: "1" } : {}),
				},
				encoding: "utf8",
				timeout: 6000,
			},
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("SETUP\n");
		expect(result.stdout).not.toContain("nonce");
	});

	test.each(["valid", "fragmented", "silent", "partial", "dribble", "mismatch", "coalesced"])(
		"%s READY handoff is bounded and one-shot",
		async (kind) => {
			const f = fixture();
			const child = spawn(process.execPath, [...f.args, "--help"], {
				env: {
					...f.env,
					PI_PROCWARD_BOOTSTRAP_NONCE: "b".repeat(32),
					PI_ENTRY_HOLD: "1",
					PROCWARD_PROTOCOL: "1",
					PROCWARD_OWNER_PID: String(process.pid),
					PROCWARD_CONTRACT_ID: launchId,
					PROCWARD_LIFECYCLE_FD: "3",
				},
				stdio: ["ignore", "pipe", "pipe", "pipe"],
			});
			let output = "";
			let error = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				error += chunk.toString();
			});
			const lifecycle = child.stdio[3];
			if (!(lifecycle instanceof Duplex)) throw new Error("fixture lifecycle pipe missing");
			// A refusing peer may close before draining deliberately malformed input.
			lifecycle.on("error", (cause: Error) => {
				error += `lifecycle peer: ${cause.message}\n`;
			});
			const ready = `PROCWARD/1 READY ${process.pid} ${kind === "mismatch" ? 1 : child.pid} parent ${launchId}`;
			let dribble: NodeJS.Timeout | undefined;
			const fragments: NodeJS.Timeout[] = [];
			if (kind === "fragmented") {
				for (const [index, piece] of [ready.slice(0, 17), ready.slice(17), "\n"].entries())
					fragments.push(setTimeout(() => lifecycle.write(piece), 150 + index * 60));
			} else if (kind === "partial") lifecycle.end(ready);
			else if (kind === "dribble") dribble = setInterval(() => lifecycle.write("x"), 100);
			else if (kind !== "silent")
				lifecycle.write(`${ready}\n${kind === "coalesced" ? `PROCWARD/1 OWNER-LOSS ${launchId}\n` : ""}`);
			const startedAt = Date.now();
			let guarded = false;
			const guard = setTimeout(() => {
				guarded = true;
				child.kill("SIGKILL");
			}, 6000);
			try {
				const status = await new Promise<number | null>((resolve, reject) => {
					child.once("error", reject);
					child.once("close", (code) => resolve(code));
				});
				expect(guarded).toBe(false);
				expect(Date.now() - startedAt).toBeLessThan(4500);
				if (kind === "valid" || kind === "fragmented") {
					expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
					expect(status, error).toBe(0);
					expect(output).toContain("SETUP\n");
					expect(output).not.toMatch(/nonce|protocol/);
				} else if (kind !== "coalesced") {
					expect(status).toBe(1);
					expect(output).toBe("");
					expect(error).toMatch(/READY|lifecycle/);
					expect(readFileSync(f.graph, "utf8")).not.toMatch(/\/src\/(main|cli\/setup)\.ts/);
				} else {
					expect(error).toContain("process owner gone (owner-loss)");
				}
			} finally {
				clearTimeout(guard);
				clearInterval(dribble);
				for (const timer of fragments) clearTimeout(timer);
				lifecycle.destroy();
			}
		},
	);
});
