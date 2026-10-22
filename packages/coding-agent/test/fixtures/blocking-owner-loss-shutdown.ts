import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";

export default function (pi: ExtensionAPI) {
	process.on("SIGUSR2", () => {
		writeFileSync(`${process.env.REVIEW_ROOT}/preblocked`, "blocked");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12_000);
	});
	pi.on("session_start", () => writeFileSync(`${process.env.REVIEW_ROOT}/extension-ready`, "ready"));
	process.prependListener("SIGCONT", () =>
		writeFileSync(`${process.env.REVIEW_ROOT}/death-wake`, String(process.ppid)),
	);
	pi.on("session_shutdown", () => {
		writeFileSync(`${process.env.REVIEW_ROOT}/shutdown-started`, "started");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12_000);
		writeFileSync(`${process.env.REVIEW_ROOT}/shutdown-done`, "done");
	});
}
