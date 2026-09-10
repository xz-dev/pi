import assert from "node:assert/strict";
import test from "node:test";
import { normalizeArchitecture, operatingSystemArchitecture } from "./lib/runtime-architecture.mjs";

test("normalizes supported operating-system architecture names", () => {
	assert.equal(normalizeArchitecture("X64\r\n"), "x64");
	assert.equal(normalizeArchitecture("Arm64"), "arm64");
});

test("Windows uses RuntimeInformation OSArchitecture rather than the process architecture under WOW", () => {
	assert.equal(operatingSystemArchitecture({ platform: "win32", nodeArchitecture: "x64", runtimeInformationOutput: "Arm64\r\n" }), "arm64");
	assert.equal(operatingSystemArchitecture({ platform: "win32", nodeArchitecture: "ia32", runtimeInformationOutput: "X64\r\n" }), "x64");
});
