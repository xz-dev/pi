#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Test userspace only; these libraries are not shipped in the Pi bundle.
// Alpine 3.22 matches the pinned Bun musl images. Freeze both downloads and
// loaded ELF bytes, including XCB's transitive closure except the base musl.
const inputs = {
	x64: [
		["libxcb-1.17.0-r0.apk", "b46b8cbf0098fc320ebb6d29ed3df47516b5b45c06a5aeee363078c5b7781447", "libxcb.so.1", "d7c721d4ee2f4341171095222b8a4f779d809d2e23a6d07a5c345f8af75d68f2"],
		["libxau-1.0.12-r0.apk", "cc1cb2d10587aa1ab850ac881f3223574555bf7acf7bce5e3c46d2c95534e95c", "libXau.so.6", "d5d7809aba9aff07d2ae871dd9890a194eab162ff78b1e93086853c736cfc76e"],
		["libxdmcp-1.1.5-r1.apk", "2d26da8177d27a870067eba372ef0c01b0229e10a084b5d58449f094068255e7", "libXdmcp.so.6", "a00f29b95ee44a04813dc27d11e088ba26130090f10b751e7098f3bea77e8c51"],
		["libbsd-0.12.2-r0.apk", "22f0a114fb8cbe8d828f48b9fe44f0119d7131fcfa5370c9841b017f2f678137", "libbsd.so.0", "97c20792a33dff8415ec49cfe265b3c5f6ae4129f3732ca32dc9d5c439942cb2"],
		["libmd-1.1.0-r0.apk", "47294e0d7bf7763ae4e22f49b1bd6ee8fc3cd0af1b86e1cc8a5a352abd4e8d08", "libmd.so.0", "21fd7d297ed47aada51615793f09c7536a52de574d5cdd039a001890f327d278"],
	],
	arm64: [
		["libxcb-1.17.0-r0.apk", "c7d7f55f5ea61eefc749201a041e774ad60a5e0ca4d59acc89eb56f6c201b08f", "libxcb.so.1", "37b5950b0a216608ed5f9eb3e3c8244c6839aa7920901ee4ee2c663bc9ddfe4a"],
		["libxau-1.0.12-r0.apk", "1dcbaf3a2995c60ba9f442e580eea9e03a1d68898b54bdc9eeba25a68124888b", "libXau.so.6", "541039f77baf79bff82c859dbecb41d046fe1c13b172392160312cc2d39f5a52"],
		["libxdmcp-1.1.5-r1.apk", "6988bfc23df3e551de62de498bbe661963f13bac2c48b501d82ddd0a3d3eafe5", "libXdmcp.so.6", "f79259348abadc0b32ae61fef7032ac7afcd3c1319b0095c190bdc1394c483ad"],
		["libbsd-0.12.2-r0.apk", "8a51acec613887f12a294685465c17b0d03f2c9b1adfae805d8e6b8d8421cd77", "libbsd.so.0", "6304e54559e94174d59cd30f3f2876f6269f329bf7034952f94573ac49038d02"],
		["libmd-1.1.0-r0.apk", "b1624431ed1932069c17b02f21e1fb2c8d4db42c3be1e2f8c5a22ccac27b78aa", "libmd.so.0", "e6555b271864e03a0229410b971d4e62541775fef7b846ff64f162450043bc85"],
	],
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function muslSmokeLibraries(arch) {
	if (!Object.hasOwn(inputs, arch)) throw new Error(`unsupported musl architecture: ${arch}`);
	return Object.fromEntries(inputs[arch].map(([, , name, digest]) => [name, digest]));
}

export function verifyMuslSmokeLibraries(directory, arch) {
	if (!directory) throw new Error("musl acceptance requires PI_XZ_MUSL_LIBRARIES");
	const libraries = muslSmokeLibraries(arch);
	for (const [name, digest] of Object.entries(libraries)) {
		if (sha256(readFileSync(join(directory, "usr/lib", name))) !== digest) throw new Error(`musl library digest mismatch: ${name}`);
	}
	return libraries;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [arch, output] = process.argv.slice(2);
	muslSmokeLibraries(arch);
	if (!output) throw new Error("Usage: prepare-musl-smoke.mjs <x64|arm64> <output-dir>");
	const root = resolve(output);
	mkdirSync(root, { recursive: true });
	for (const [name, digest] of inputs[arch]) {
		const url = `https://dl-cdn.alpinelinux.org/alpine/v3.22/main/${arch === "x64" ? "x86_64" : "aarch64"}/${name}`;
		const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
		const bytes = Buffer.from(await response.arrayBuffer());
		if (sha256(bytes) !== digest) throw new Error(`APK digest mismatch: ${name}`);
		const archive = join(root, name);
		writeFileSync(archive, bytes);
		execFileSync("tar", ["-xzf", archive, "-C", root, "usr/lib"]);
	}
	verifyMuslSmokeLibraries(root, arch);
	console.log(`Prepared hash-verified ${arch} XCB test libraries`);
}
