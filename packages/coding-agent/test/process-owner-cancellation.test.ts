import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { Duplex } from "node:stream";
import { afterEach, describe, it, vi } from "vitest";
import { observeOwnedProcess } from "../src/utils/process-owner.ts";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
	Object.defineProperty(process, "platform", originalPlatform);
	vi.restoreAllMocks();
});

// Independent read/write halves model native control, unlike a loopback PassThrough.
describe("owned cancellation transport (unit, not containment proof)", () => {
	for (const platform of ["linux", "freebsd", "darwin", "win32"]) {
		for (const complete of [false, true]) {
			it(`${platform} late cancel retains response and ${complete ? "accepts" : "rejects missing"} C`, async () => {
				Object.defineProperty(process, "platform", { value: platform, configurable: true });
				const writes: string[] = [];
				const lease = new Duplex({
					read() {},
					write(chunk: Buffer, _encoding, callback) {
						writes.push(chunk.toString());
						callback();
					},
				});
				const child = Object.assign(new ChildProcess(), { pid: 123, stdio: [null, null, null, lease] });
				const kill = vi.spyOn(child, "kill").mockReturnValue(true);
				const owner = observeOwnedProcess(child);
				const checked = complete
					? assert.doesNotReject(owner.completion)
					: assert.rejects(owner.completion, { code: "ERR_PROCESS_OWNER_CLEANUP" });
				lease.emit("data", 'S{"pid":456}\nX{"code":0,"signal":null}\n');
				owner.cancel();
				owner.cancel();
				assert.deepEqual(writes, platform === "win32" ? ["K"] : []);
				assert.equal(lease.writableEnded, platform !== "win32");
				assert.equal(lease.destroyed, false);
				assert.deepEqual(kill.mock.calls, platform === "win32" ? [] : [["SIGCONT"]]);
				if (complete) lease.push("C\n");
				lease.push(null);
				child.emit("close", 0, null);
				await checked;
				lease.destroy();
			});
		}
	}
});
