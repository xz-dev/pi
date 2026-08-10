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
			return windowsResult("sse2 avx2\r\n");
		},
	});
	assert.equal(features, "Fixture CPU\nsse2 avx2");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].command, "powershell");
	assert.deepEqual(calls[0].args.slice(0, 2), ["-NoProfile", "-NonInteractive"]);
	assert.match(calls[0].args.at(-1), /IsProcessorFeaturePresent\(10\)/);
	assert.match(calls[0].args.at(-1), /IsProcessorFeaturePresent\(40\)/);
	assert.equal(calls[0].options.timeout, 10_000);
});

test("Windows x64 preserves baseline-only feature evidence", () => {
	assert.equal(
		cpuFeatures({ platform: "win32", arch: "x64", cpuModel: "Baseline CPU", run: () => windowsResult("sse2\n") }),
		"Baseline CPU\nsse2",
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
	assert.equal(cpuFeatures({ platform: "linux", arch: "x64", linuxCpuInfo: "flags : sse2 avx2\n" }), "flags : sse2 avx2");
	assert.equal(
		cpuFeatures({ platform: "darwin", arch: "x64", cpuModel: "Mac CPU", run: () => windowsResult("SSE2 AVX2\n") }),
		"SSE2 AVX2",
	);
});
