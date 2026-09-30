import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

export function run(command, args, env = process.env) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { env, windowsHide: true });
		child.stdin.end();
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			if (process.platform === "win32" && child.pid) {
				const taskkill = join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", "taskkill.exe");
				spawnSync(taskkill, ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
			} else {
				child.kill("SIGKILL");
			}
			reject(new Error(`${command} ${args.join(" ")} timed out: ${stdout}${stderr}`));
		}, 120_000);
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", (error) => {
			clearTimeout(timer);
			settled = true;
			reject(error);
		});
		// Process exit can precede the final stdout/stderr data events.
		child.once("close", (code, signal) => {
			if (settled) return;
			clearTimeout(timer);
			settled = true;
			if (code === 0) resolveRun(stdout);
			else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code}): ${stdout}${stderr}`));
		});
	});
}
