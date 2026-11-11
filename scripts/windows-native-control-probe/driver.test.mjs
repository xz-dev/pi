import assert from "node:assert/strict";
import test from "node:test";
import { runCase, validateRecords } from "./driver.mjs";

const valid = "PROCWARD/1 S 42 kernel\nPROCWARD/1 X 4275878552\nPROCWARD/1 C kernel\n";

test("controlled JS peer: C and EOF cannot replace actual child close (not native evidence)", async () => {
	const code = `const fs=require('node:fs');fs.writeSync(3,'PROCWARD/1 S '+process.pid+' kernel\\nPROCWARD/1 X 23\\nPROCWARD/1 C kernel\\n');fs.closeSync(3);process.stdin.resume();process.stdin.once('data',()=>process.exit(23));`;
	const result = await runCase(
		"controlled JS only",
		process.execPath,
		["-e", code],
		true,
		process.cwd(),
		async ({ child, state, until }) => {
			await until(() => state.eof);
			assert.equal(state.closed, undefined);
			child.stdin.write("release");
		},
		process.env,
	);
	assert.equal(result.closed.code, 23);
	assert.equal(result.childCloseObserved, true);
	assert.equal(result.rescue, false);
});

test("native u32 survives and C still requires actual transport EOF", () => {
	assert.deepEqual(validateRecords(valid, 42, false), { primary: 0xfedcba98, complete: false });
	assert.deepEqual(validateRecords(valid, 42, true), { primary: 0xfedcba98, complete: true });
	assert.deepEqual(validateRecords("PROCWARD/1 S 42 kernel\n", 42, false), { primary: undefined, complete: false });
});

test("wrong owner, scope, order and extra records fail instead of confirming cleanup", () => {
	for (const text of [
		valid.replace("S 42", "S 43"),
		valid.replaceAll("kernel", "best-effort"),
		valid.replace("C kernel", "E 125"),
		valid + "PROCWARD/1 C kernel\n",
		valid.replace("X 4275878552", "C kernel"),
	]) {
		assert.throws(() => validateRecords(text, 42, true));
	}
});

test("missing C, partial EOF, oversized records and non-ASCII cannot pass", () => {
	for (const text of [
		valid.split("PROCWARD/1 C")[0],
		valid.slice(0, -1),
		"x".repeat(256),
		valid.replace("kernel", "kern\x80el"),
	]) {
		assert.throws(() => validateRecords(text, 42, true));
	}
});

test("native result must be canonical decimal u32", () => {
	for (const value of ["-1", "01", "4294967296", "NaN"]) {
		assert.throws(() => validateRecords(valid.replace("4275878552", value), 42, true));
	}
	assert.equal(validateRecords(valid.replace("4275878552", "0"), 42, true).primary, 0);
});
