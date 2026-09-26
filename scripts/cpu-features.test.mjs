import assert from "node:assert/strict";
import test from "node:test";
import { cpuFeatures } from "./lib/cpu-features.mjs";

function windowsResult(stdout, status = 0, stderr = "") {
	return { stdout, stderr, status };
}

test("Windows x64 records only processor features confirmed by the native API", () => {
	const calls = [];
	const features = cpuFeatures({
		platform: "win32",
		arch: "x64",
		cpuModel: "Fixture CPU",
		run(command, args, options) {
			calls.push({ command, args, options });
			return windowsResult("sse4_2 avx2\r\n");
		},
	});
	assert.equal(features, "Fixture CPU\nsse4_2 avx2");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].command, "powershell");
	assert.deepEqual(calls[0].args.slice(0, 2), ["-NoProfile", "-NonInteractive"]);
	assert.match(calls[0].args.at(-1), /IsProcessorFeaturePresent\(38\)/);
	assert.match(calls[0].args.at(-1), /IsProcessorFeaturePresent\(40\)/);
	assert.equal(calls[0].options.timeout, 10_000);
});

test("Windows x64 preserves Bun 1.4 baseline feature evidence", () => {
	assert.equal(
		cpuFeatures({ platform: "win32", arch: "x64", cpuModel: "Baseline CPU", run: () => windowsResult("sse4_2\n") }),
		"Baseline CPU\nsse4_2",
	);
});

test("Windows x64 CPU feature detection fails closed", () => {
	assert.throws(
		() => cpuFeatures({ platform: "win32", arch: "x64", cpuModel: "CPU", run: () => windowsResult("", 1, "probe failed") }),
		/Windows CPU feature detection failed: probe failed/,
	);
});

test("Windows arm64 records its model without probing x64 features", () => {
	let called = false;
	assert.equal(
		cpuFeatures({ platform: "win32", arch: "arm64", cpuModel: "Cobalt 100", run: () => { called = true; return windowsResult(""); } }),
		"Cobalt 100",
	);
	assert.equal(called, false);
});

test("Linux and Darwin feature evidence remains compatible", () => {
	assert.equal(cpuFeatures({ platform: "linux", arch: "x64", linuxCpuInfo: "flags : sse4_2 avx2\n" }), "flags : sse4_2 avx2");
	assert.equal(
		cpuFeatures({ platform: "darwin", arch: "x64", cpuModel: "Mac CPU", run: () => windowsResult("SSE4.2 AVX2\n") }),
		"SSE4.2 AVX2",
	);
});
