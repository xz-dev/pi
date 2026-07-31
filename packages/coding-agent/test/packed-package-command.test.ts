import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPackedPackageCommand } from "./helpers/packed-package-command.ts";

describe("packed package command runner", () => {
	it.skipIf(process.platform === "win32")(
		"kills a ready command that ignores graceful termination",
		async () => {
			const fixture = join(import.meta.dirname, "fixtures", "ignore-termination.mjs");
			await expect(runPackedPackageCommand("node", [fixture], process.cwd(), 100, "ready\n")).rejects.toThrow(
				/Termination: SIGKILL/,
			);
		},
		2_000,
	);
});
