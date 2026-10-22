import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import installDescendants from "./owner-loss-descendants.ts";

function blockMain() {
	if (process.env.REVIEW_BUSY === "1") {
		const deadline = performance.now() + 12_000;
		while (performance.now() < deadline) {
			/* Deliberately block main without yielding. */
		}
	} else {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12_000);
	}
}

export default function (pi: ExtensionAPI) {
	installDescendants(pi);
	process.on("SIGUSR2", () => {
		writeFileSync(`${process.env.REVIEW_ROOT}/preblocked`, "blocked");
		blockMain();
	});
	pi.on("session_start", () => writeFileSync(`${process.env.REVIEW_ROOT}/extension-ready`, "ready"));
	process.prependListener("SIGCONT", () =>
		writeFileSync(`${process.env.REVIEW_ROOT}/death-wake`, String(process.ppid)),
	);
	pi.on("session_shutdown", () => {
		writeFileSync(`${process.env.REVIEW_ROOT}/shutdown-started`, "started");
		blockMain();
		writeFileSync(`${process.env.REVIEW_ROOT}/shutdown-done`, "done");
	});
}
