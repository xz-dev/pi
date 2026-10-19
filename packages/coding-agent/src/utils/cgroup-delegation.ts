import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { AgentSessionRuntimeDiagnostic } from "../core/agent-session-services.ts";

const WARNING =
	"Linux cgroup delegation is unavailable; set PI_ENV_CGROUP_PARENT to a writable delegated cgroup subtree. Try systemd-run --user --scope -p Delegate=yes pi, or ask your administrator to enable Delegate=yes for user@.service. External cgroup runner remains disabled.";

/** Read-only startup hint, not a capability grant or an activation of the external runner. */
export function cgroupDelegationDiagnostics(options: {
	offlineMode: boolean;
	quietStartup: boolean | "header";
}): AgentSessionRuntimeDiagnostic[] {
	if (process.platform !== "linux" || options.offlineMode || options.quietStartup === true) return [];
	try {
		const mount = readFileSync("/proc/self/mountinfo", "utf8")
			.split("\n")
			.find((line) => line.includes(" - cgroup2 "));
		if (!mount) return [];
		const fields = mount.split(" ");
		const decodeMountPath = (path: string) =>
			path.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
		const root = decodeMountPath(fields[3]);
		const directory = realpathSync(decodeMountPath(fields[4]));
		// Conservative kernel prerequisites: no probing by mkdir, open-for-write or migration.
		if (!existsSync(join(directory, "cgroup.subtree_control"))) return [];
		const runtime = process.env.XDG_RUNTIME_DIR;
		if (!runtime || (!existsSync(join(runtime, "systemd/private")) && !existsSync(join(runtime, "bus")))) return [];
		const membership = readFileSync("/proc/self/cgroup", "utf8")
			.split("\n")
			.find((line) => line.startsWith("0::"))
			?.slice(3);
		if (!membership) return [];
		const suffix = relative(root, membership);
		if (suffix.startsWith("..") || isAbsolute(suffix)) return [];
		const own = join(directory, suffix);
		let parent: string | undefined;
		try {
			const configured = process.env.PI_ENV_CGROUP_PARENT;
			if (configured) {
				const resolved = realpathSync(configured);
				const path = relative(directory, resolved);
				if (!path.startsWith("..") && !isAbsolute(path)) parent = resolved;
			}
		} catch {
			// An unusable configured parent must not hide the delegation hint.
		}
		// cgroup.kill does not exist at the hierarchy root, even on supported kernels.
		if (!existsSync(join(own, "cgroup.kill")) && (!parent || !existsSync(join(parent, "cgroup.kill")))) return [];
		let delegated = false;
		try {
			accessSync(own, constants.W_OK | constants.X_OK);
			if (parent) {
				accessSync(parent, constants.W_OK | constants.X_OK);
				accessSync(join(parent, "cgroup.procs"), constants.W_OK);
				accessSync(join(parent, "cgroup.subtree_control"), constants.W_OK);
				delegated = true;
			}
		} catch {
			// Missing permissions/configuration is the condition this warning describes.
		}
		return delegated ? [] : [{ type: "warning", message: WARNING }];
	} catch {
		// Unknown topology/permissions cannot establish that delegation could help.
		return [];
	}
}
