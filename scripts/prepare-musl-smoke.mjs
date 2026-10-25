#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
// Full ps and its DT_NEEDED closure are CI-only; the immutable image supplies musl.
const processInputs = {
	x64: [
		["procps-ng-4.0.4-r3.apk", "012feba89e6112b84d6afce6c6c1d6c99d8a838141aa6a3439d0bbfd5ba3fc46", "bin/ps", "c90cec038c791464c86c0067b7bf7b51ecd49b877932189829f647a6a65f1722"],
		["libintl-0.24.1-r0.apk", "1e9900a63a851e790b28d201d5c11872a5ff74322fd998c06ac952c6a2ed1ce4", "usr/lib/libintl.so.8", "4a76853f25c3c236211af6326d35273b32aa27a52704a10e8c23f96361d04316"],
		["libproc2-4.0.4-r3.apk", "24dbb04c88398f28e67a3858e8bd443ab27cab130a61596521480e86801dddce", "usr/lib/libproc2.so.0", "4bc07065728f54a9a3cb44753425f5a49f96e406c834c8a3cac644d030e09a4f"],
		["utmps-libs-0.1.3.1-r0.apk", "3d1b9714c720828355c2b231fa188791f2b3e5dc26999681765d5adbbf951989", "usr/lib/libutmps.so.0.1", "7e9b742ad6fe08e366500a8d12b2e7c5757058ae1187ed9d1932998a521742e5"],
		["skalibs-libs-2.14.4.0-r0.apk", "b00cb52d7c9c1309b2c2a11b654162ebabd728cf61898326aeffb39f2a27240a", "usr/lib/libskarnet.so.2.14", "89b515a770dff3a198c9f8c2f9ae3236c54c44081b8435aee3be55f11e2f1acb"],
	],
	arm64: [
		["procps-ng-4.0.4-r3.apk", "1cdc566a6ab1a3aa79f4827eb73cc1b55220bfb003a07b5094fda9c312236236", "bin/ps", "312a0eecd6f315cedfd9fa3b29b225a5440482fbb6a6d4330644f1050a49e4a6"],
		["libintl-0.24.1-r0.apk", "17bacc149386d7dcb2ed4488afddc2dba644081cbc134b5839fbbe5e1b875bf9", "usr/lib/libintl.so.8", "fa15293bf4eff041cf7fe07939a1731535f0f34cd31866bdf08abf7e74e4706f"],
		["libproc2-4.0.4-r3.apk", "f3eb52694f301f7907b6e25fb5639295fe5ba0726b883296aa0def4f69979508", "usr/lib/libproc2.so.0", "3dfe823f5113a22e0d9921116be7e245dec815cc0e215a7959462bd9366b8612"],
		["utmps-libs-0.1.3.1-r0.apk", "dbc6a9bd1d1899074b60ada4ad7e8d3ce6eaabb5d9e3ff532c27d78c82d38a40", "usr/lib/libutmps.so.0.1", "fdb74b9362551e73dc0797115c814535b31e52cd3cc73debad8a03302f9552b7"],
		["skalibs-libs-2.14.4.0-r0.apk", "cf56900eea79347e8ccdaccb2917a19dae138d1eb083b4b80f85ea1bd73998be", "usr/lib/libskarnet.so.2.14", "7244025be37903d9735ab02931faf351f4ece07c6dac1764ecc2ea26741b0788"],
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

export function muslSmokeProcessTools(arch) {
	if (!Object.hasOwn(processInputs, arch)) throw new Error(`unsupported musl architecture: ${arch}`);
	return Object.fromEntries(processInputs[arch].map(([, , file, digest]) => [file, digest]));
}

export function verifyMuslSmokeProcessTools(directory, arch) {
	if (!directory) throw new Error("musl process inventory requires PI_XZ_MUSL_LIBRARIES");
	const tools = muslSmokeProcessTools(arch);
	for (const [name, digest] of Object.entries(tools)) {
		const file = join(directory, name);
		const bytes = readFileSync(file);
		if (sha256(bytes) !== digest) throw new Error(`musl process tool digest mismatch: ${name}`);
		if (bytes.length < 20 || bytes.subarray(0, 4).toString("hex") !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== (arch === "x64" ? 62 : 183)) throw new Error(`musl process tool architecture mismatch: ${name}`);
		if (name === "bin/ps" && (!statSync(file).isFile() || !(statSync(file).mode & 0o111))) throw new Error("musl process inventory ps is not executable");
	}
	return tools;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [arch, output] = process.argv.slice(2);
	muslSmokeLibraries(arch);
	if (!output) throw new Error("Usage: prepare-musl-smoke.mjs <x64|arm64> <output-dir>");
	const root = resolve(output);
	mkdirSync(root, { recursive: true });
	for (const [name, digest, file] of [...inputs[arch].map(([name, digest, library]) => [name, digest, `usr/lib/${library}`]), ...processInputs[arch]]) {
		const url = `https://dl-cdn.alpinelinux.org/alpine/v3.22/main/${arch === "x64" ? "x86_64" : "aarch64"}/${name}`;
		const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
		const bytes = Buffer.from(await response.arrayBuffer());
		if (sha256(bytes) !== digest) throw new Error(`APK digest mismatch: ${name}`);
		const archive = join(root, name);
		writeFileSync(archive, bytes);
		execFileSync("tar", ["-xzf", archive, "-C", root, file === "bin/ps" ? file : "usr/lib"]);
	}
	verifyMuslSmokeLibraries(root, arch);
	verifyMuslSmokeProcessTools(root, arch);
	console.log(`Prepared hash-verified ${arch} XCB and procps test userspace`);
}
