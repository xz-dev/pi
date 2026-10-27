import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import installDescendants from "./owner-loss-descendants.ts";

export default function (pi: ExtensionAPI) {
	installDescendants(pi);
	pi.on("session_start", () => writeFileSync(`${process.env.REVIEW_ROOT}/extension-ready`, "ready"));
	pi.on("session_shutdown", async () => {
		writeFileSync(`${process.env.REVIEW_ROOT}/shutdown-started`, "started");
		await new Promise<void>(() => {});
	});
}
