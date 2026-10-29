#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [destination, expectedOs, expectedArch] = process.argv.slice(2);
const hostOs = process.platform === "win32" ? "windows" : process.platform;
if ((expectedOs && expectedOs !== hostOs) || (expectedArch && expectedArch !== process.arch))
	throw new Error("Procward transport must be built on the target OS and architecture");
const source = join(root, "packages/coding-agent/native/procward/transport.c");
const output = resolve(destination ?? join(root, "packages/coding-agent/dist/native/procward-transport/procward-transport.node"));
const scratch = mkdtempSync(join(tmpdir(), "pi-procward-transport-"));
try {
	const built = join(scratch, "procward-transport.node");
	if (process.platform === "win32") {
		// Same MSVC discovery as the existing TUI addon; compile only this runner's architecture.
		const vswhere = join(process.env["ProgramFiles(x86)"], "Microsoft Visual Studio/Installer/vswhere.exe");
		const installation = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" }).trim();
		if (!installation) throw new Error("Microsoft C++ Build Tools are required for the procward consumer adapter");
		const quote = (value) => `"${value.replaceAll('"', '""')}"`;
		const batch = join(scratch, "build.cmd");
		writeFileSync(batch, ["@echo off", `call ${quote(join(installation, "Common7/Tools/VsDevCmd.bat"))} -no_logo -arch=${process.arch} -host_arch=${process.arch}`, "if errorlevel 1 exit /b %errorlevel%", `cl /nologo /TC /std:c11 /W4 /O1 /LD ${quote(source)} /Fe:${quote(built)} /link /OPT:REF /OPT:ICF`, "if errorlevel 1 exit /b %errorlevel%"].join("\r\n"));
		execFileSync("cmd.exe", ["/d", "/s", "/c", batch], { cwd: scratch, stdio: "inherit", timeout: 120000 });
	} else {
		const flags = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-Os", "-fPIC", "-fvisibility=hidden"];
		// Strict POSIX mode hides dlfcn's RTLD_DEFAULT on macOS and FreeBSD; their default headers already expose POSIX.
		if (process.platform === "linux") flags.push("-D_POSIX_C_SOURCE=200809L");
		if (process.platform === "darwin") flags.push("-dynamiclib");
		// FreeBSD binds unversioned references to the oldest symbol version (freebsd11 fstat); link libc for current ABIs.
		else if (process.platform === "freebsd") flags.push("-shared");
		else flags.push("-shared", "-nostdlib", "-Wl,--unresolved-symbols=ignore-all");
		execFileSync(process.env.CC || "cc", [...flags, source, "-o", built], { stdio: "inherit", timeout: 120000 });
	}
	mkdirSync(dirname(output), { recursive: true });
	const staging = mkdtempSync(join(dirname(output), ".procward-transport-"));
	try {
		const replacement = join(staging, "procward-transport.node");
		copyFileSync(built, replacement);
		// Loaded addons retain the old inode; never truncate executable pages in a live process.
		renameSync(replacement, output);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	console.log(`Built ${output}`);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
