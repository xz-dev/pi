import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const CASE_MS = 8000;

/** Windows kernel task records; C is not confirmation until transport EOF. */
export function validateRecords(text, pid, eof) {
	assert(text.length <= 768 && /^[\x20-\x7e\n]*$/.test(text), "invalid/bounded task bytes");
	const lines = text.split("\n");
	const partial = lines.pop();
	assert(partial.length < 256 && lines.every((line) => line.length < 256), "record exceeds 256 bytes");
	assert(!eof || partial === "", "truncated task record");
	assert(lines.length <= 3, "unexpected task record");
	if (lines.length >= 1) assert.equal(lines[0], `PROCWARD/1 S ${pid} kernel`);
	let primary;
	if (lines.length >= 2) {
		assert(/^PROCWARD\/1 X (0|[1-9][0-9]*)$/.test(lines[1]), "invalid native result");
		primary = Number(lines[1].slice("PROCWARD/1 X ".length));
		assert(Number.isInteger(primary) && primary <= 0xffffffff, "native result exceeds u32");
	}
	if (lines.length >= 3) assert.equal(lines[2], "PROCWARD/1 C kernel");
	if (eof) assert.equal(lines.length, 3, "missing S/X/C at EOF");
	return { primary, complete: eof && lines.length === 3 };
}

function digest(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export async function runCase(name, executable, args, owned, cwd, action, env) {
	const child = spawn(executable, args, {
		cwd,
		env,
		stdio: owned ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
	});
	const state = { name, pid: child.pid, transcript: "", eof: false, guard: false, rescue: false };
	const stdout = [];
	const stderr = [];
	let failure;
	child.once("error", (error) => {
		failure = error;
	});
	child.once("close", (code, signal) => {
		state.closed = { code, signal };
	});
	child.stdout.on("data", (bytes) => stdout.push(bytes));
	child.stderr.on("data", (bytes) => stderr.push(bytes));
	const control = owned ? child.stdio[3] : undefined;
	if (control) {
		control.on("data", (bytes) => {
			try {
				assert(
					[...bytes].every((byte) => byte === 10 || (byte >= 32 && byte <= 126)),
					"non-ASCII control bytes",
				);
				state.transcript += bytes.toString("ascii");
				Object.assign(state, validateRecords(state.transcript, child.pid, false));
			} catch (error) {
				failure = error;
			}
		});
		control.once("end", () => {
			state.eof = true;
			try {
				Object.assign(state, validateRecords(state.transcript, child.pid, true));
			} catch (error) {
				failure = error;
			}
		});
		control.once("error", (error) => {
			failure = error;
		});
	}
	const limit = performance.now() + CASE_MS;
	const guard = setTimeout(() => {
		state.guard = true;
		failure = new Error(`${name}: original task guard expired`);
		if (!state.closed) {
			state.rescue = true;
			child.kill("SIGKILL");
		}
	}, CASE_MS);
	async function until(predicate) {
		while (!predicate()) {
			if (failure) throw failure;
			assert(performance.now() < limit, `${name}: original task deadline`);
			await delay(2);
		}
		if (failure) throw failure;
	}
	try {
		await action({ child, control, state, until });
		await until(() => state.closed !== undefined);
		if (owned)
			assert.deepEqual(validateRecords(state.transcript, child.pid, state.eof), {
				primary: state.primary,
				complete: true,
			});
		assert(!state.guard && !state.rescue);
		return {
			...state,
			stdout: Buffer.concat(stdout).toString("base64"),
			stderr: Buffer.concat(stderr).toString("base64"),
			childCloseObserved: true,
		};
	} catch (error) {
		error.probeCase = state;
		throw error;
	} finally {
		clearTimeout(guard);
		if (!state.closed) {
			state.rescue = true;
			child.kill("SIGKILL");
		}
	}
}

async function main() {
	assert.equal(process.platform, "win32", "real Windows only; never execute procward on the Linux host");
	const [binary, fixture, out, expectedRuntime, expectedArch] = process.argv.slice(2);
	assert.equal(process.arch, expectedArch, "native architecture, not emulated runtime");
	assert.equal(process.versions.bun ? "bun" : "node", expectedRuntime);
	assert.equal(process.versions.bun ?? process.versions.node, expectedRuntime === "bun" ? "1.4.4" : "22.22.2");
	for (const file of [binary, fixture]) {
		const pe = readFileSync(file);
		assert.equal(pe.subarray(0, 2).toString(), "MZ");
		const offset = pe.readUInt32LE(0x3c);
		assert.equal(pe.readUInt32LE(offset), 0x4550);
		assert.equal(pe.readUInt16LE(offset + 4), expectedArch === "arm64" ? 0xaa64 : 0x8664);
	}
	mkdirSync(out, { recursive: true });
	const nonce = randomBytes(16).toString("hex");
	const env = { ...process.env, NATIVE_CONTROL_PROBE_NONCE: nonce };
	const base = [
		"run",
		"--quiet",
		"--grace",
		"500ms",
		"--fatal-grace",
		"250ms",
		"--cleanup-deadline",
		"1500ms",
		"--control-fd",
		"3",
	];
	const receipt = {
		runtime: expectedRuntime,
		runtimeVersion: process.versions.bun ?? process.versions.node,
		arch: process.arch,
		platform: process.platform,
		nonce,
		binarySha256: digest(binary),
		fixtureSha256: digest(fixture),
		runtimeSha256: digest(process.execPath),
		driverSha256: digest(fileURLToPath(import.meta.url)),
		transport: "public child_process stdio[3] to real Cargo +crt-static procward",
		cases: [],
	};
	try {
		const code = `const chunks=[]; process.stdin.on('data',b=>chunks.push(b)); process.stdin.on('end',()=>{const bytes=Buffer.concat([Buffer.from(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),nonce:process.env.NATIVE_CONTROL_PROBE_NONCE})),Buffer.from([0,255,13,10]),...chunks]);process.stdout.write(bytes,()=>process.stderr.write(Buffer.from([101,0,255,13,10]),()=>{process.exitCode=17}));});`;
		const command = ["-e", code, "two words", 'quote"value', "unicode-猫"];
		const input = Buffer.from([0, 255, 1, 13, 10]);
		const ordinaryAction = async ({ child }) => {
			child.stdin.end(input);
		};
		const direct = await runCase("ordinary-direct", process.execPath, command, false, out, ordinaryAction, env);
		const ordinary = await runCase(
			"ordinary-owned",
			binary,
			[...base, "--", process.execPath, ...command],
			true,
			out,
			ordinaryAction,
			env,
		);
		for (const field of ["stdout", "stderr", "closed"])
			assert.deepEqual(ordinary[field], direct[field], `ordinary ${field} changed`);
		assert.equal(ordinary.primary, 17);
		receipt.cases.push({ ...ordinary, baseline: direct, unchangedStdinStdoutStderrArgvCwdEnvAndStatus: true });
		const highDirect = await runCase(
			"u32-direct",
			fixture,
			["exit", "4275878552"],
			false,
			out,
			async ({ child }) => {
				child.stdin.end();
			},
			env,
		);
		const high = await runCase(
			"u32-owned",
			binary,
			[...base, "--", fixture, "exit", "4275878552"],
			true,
			out,
			async ({ child }) => {
				child.stdin.end();
			},
			env,
		);
		assert.equal(high.primary, 0xfedcba98);
		assert.deepEqual(high.closed, highDirect.closed, "full native result changed from direct execution");
		receipt.cases.push({ ...high, baseline: highDirect });
		for (const cancel of [false, true]) {
			const dir = path.join(out, cancel ? "retained-cancel" : "retained-natural");
			mkdirSync(dir);
			const retained = await runCase(
				cancel ? "retained-cancel" : "retained-natural",
				binary,
				[...base, "--retain-descendants", "--", fixture, "retained-task", dir],
				true,
				out,
				async ({ child, control, state, until }) => {
					await until(() => existsSync(path.join(dir, "retained-ready")));
					child.stdin.write("x");
					await until(() => state.primary !== undefined);
					assert.equal(state.primary, 23);
					const hold = performance.now() + 1600;
					await until(() => {
						assert(
							!state.eof && !state.transcript.includes("PROCWARD/1 C ") && !state.closed,
							"X killed retained work",
						);
						return performance.now() >= hold;
					});
					// Reuse procward's causal fixture: acknowledgement after 1600ms
					// proves live work past the unchanged 1500ms cleanup budget.
					writeFileSync(path.join(dir, "retained-probe"), "prove liveness after cleanup budget");
					await until(() => existsSync(path.join(dir, "retained-probed")));
					state.workerLiveAfterCleanupBudget = true;
					state.workerPid = Number(readFileSync(path.join(dir, "retained-worker.pid"), "utf8"));
					assert(Number.isSafeInteger(state.workerPid) && state.workerPid > 0);
					if (cancel) control.write("PROCWARD/1 CANCEL\n");
					else writeFileSync(path.join(dir, "retained-release"), "finish naturally");
				},
				env,
			);
			assert.equal(retained.primary, 23);
			assert.equal(retained.closed.signal, null);
			assert.equal(retained.closed.code, 23);
			assert.equal(existsSync(path.join(dir, "retained-finished")), !cancel);
			receipt.cases.push(retained);
		}
		receipt.passed = true;
	} catch (error) {
		receipt.passed = false;
		receipt.error = String(error.stack ?? error);
		receipt.failedCase = error.probeCase;
		throw error;
	} finally {
		assert.equal(digest(binary), receipt.binarySha256, "helper changed during execution");
		assert.equal(digest(fixture), receipt.fixtureSha256, "fixture changed during execution");
		writeFileSync(path.join(out, "result.json"), `${JSON.stringify(receipt, null, 2)}\n`);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
