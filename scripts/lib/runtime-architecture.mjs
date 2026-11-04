import { execFileSync } from "node:child_process";
import { arch as nodeArch, platform } from "node:os";

export function normalizeArchitecture(value) {
	const normalized = value.trim().toLowerCase();
	if (normalized === "x64" || normalized === "amd64" || normalized === "x86_64") return "x64";
	if (normalized === "arm64" || normalized === "aarch64") return "arm64";
	throw new Error(`Unsupported operating-system architecture: ${value}`);
}

export function operatingSystemArchitecture(options = {}) {
	const currentPlatform = options.platform ?? platform();
	if (currentPlatform !== "win32") return normalizeArchitecture(options.nodeArchitecture ?? nodeArch());
	const output = options.runtimeInformationOutput ?? execFileSync("powershell", [
		"-NoProfile", "-NonInteractive", "-Command",
		"[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()",
	], { encoding: "utf8" });
	return normalizeArchitecture(output);
}
