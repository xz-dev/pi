import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";

// Microsoft IsProcessorFeaturePresent constants:
// 38 = PF_SSE4_2_INSTRUCTIONS_AVAILABLE, 40 = PF_AVX2_INSTRUCTIONS_AVAILABLE.
const WINDOWS_FEATURE_SCRIPT = `
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class PiCpuFeatures { [DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint feature); }'
$features = @()
if ([PiCpuFeatures]::IsProcessorFeaturePresent(38)) { $features += 'sse4_2' }
if ([PiCpuFeatures]::IsProcessorFeaturePresent(40)) { $features += 'avx2' }
$features -join ' '
`;

export function cpuFeatures(options = {}) {
	const hostPlatform = options.platform ?? platform();
	const hostArch = options.arch ?? arch();
	const cpuModel = options.cpuModel ?? cpus()[0]?.model ?? "unknown";
	const run = options.run ?? spawnSync;

	if (hostPlatform === "linux") {
		return (options.linuxCpuInfo ?? readFileSync("/proc/cpuinfo", "utf8")).match(/^Features\s*:.*|^flags\s*:.*$/m)?.[0] ?? "unknown";
	}
	if (hostPlatform === "freebsd") {
		// FreeBSD's boot log records CPUID flags; hw.model only names the CPU. Minimal VM images may
		// not save /var/run/dmesg.boot, so fall back to the live kernel message buffer.
		const bootLog =
			options.freebsdBootLog ??
			(existsSync("/var/run/dmesg.boot")
				? readFileSync("/var/run/dmesg.boot", "utf8")
				: (run("sysctl", ["-n", "kern.msgbuf"], { encoding: "utf8" }).stdout ?? ""));
		return `${cpuModel}\n${bootLog.match(/Features2=.*$/m)?.[0] ?? "unknown"}`;
	}
	if (hostPlatform === "darwin") {
		const result = run("sysctl", ["-n", "machdep.cpu.features", "machdep.cpu.leaf7_features"], {
			encoding: "utf8",
		});
		return result.stdout?.trim() || cpuModel;
	}
	if (hostPlatform !== "win32" || hostArch !== "x64") {
		return cpuModel;
	}

	const result = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_FEATURE_SCRIPT], {
		encoding: "utf8",
		timeout: 10_000,
	});
	if (result.status !== 0) {
		throw new Error(
			`Windows CPU feature detection failed: ${result.stderr?.trim() || result.error?.message || `exit ${result.status ?? "unknown"}`}`,
		);
	}
	return `${cpuModel}\n${result.stdout.trim()}`;
}
