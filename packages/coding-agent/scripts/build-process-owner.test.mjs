import assert from "node:assert/strict";
import { test } from "vitest";
import { selectExecutable } from "./build-process-owner.mjs";

const executable = {
	reason: "compiler-artifact", target: { name: "pi-env", kind: ["bin"] },
	executable: "/build/aarch64-unknown-freebsd/release/pi-env",
};

test("selects Cargo's exact executable, including target/profile paths", () => {
	assert.equal(selectExecutable([{ reason: "build-finished", success: true }, executable]), executable.executable);
});

test("rejects missing, ambiguous and non-executable artifacts", () => {
	assert.throws(() => selectExecutable([]), /exactly one/);
	assert.throws(() => selectExecutable([executable, executable]), /exactly one/);
	assert.throws(() => selectExecutable([{ ...executable, executable: null }]), /exactly one/);
	assert.throws(() => selectExecutable([{ ...executable, executable: "" }]), /must not be empty/);
	assert.throws(() => selectExecutable([{ ...executable, target: { name: "pi-env", kind: ["lib"] } }]), /exactly one/);
});
