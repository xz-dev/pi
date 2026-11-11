import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveProcwardBinary } from "../src/config.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { getProcessOwnership, ownCliProcess, ownershipDisabled } from "../src/utils/procward.ts";

vi.mock("../src/utils/procward-build.ts", () => ({ procwardIncluded: false }));

afterEach(() => vi.unstubAllEnvs());

describe("artifact-owned procward exclusion", () => {
	test.each(["/invalid/helper", "sentinel"])(
		"off wins over helper %s, runtime PROCWARD and malformed handoff",
		(override) => {
			const directory = mkdtempSync(join(tmpdir(), "pi-off-artifact-"));
			try {
				const sentinel = join(directory, "procward");
				const log = join(directory, "executed");
				writeFileSync(
					sentinel,
					`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, 'bad');\n`,
				);
				chmodSync(sentinel, 0o755);
				vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", undefined);
				vi.stubEnv("PROCWARD", "1");
				vi.stubEnv("PI_PROCWARD_BIN", override === "sentinel" ? sentinel : override);
				vi.stubEnv("PATH", directory);
				vi.stubEnv("PI_PROCWARD_BOOTSTRAP_NONCE", "malformed");
				vi.stubEnv("PROCWARD_PROTOCOL", "invalid");
				vi.stubEnv("PROCWARD_LIFECYCLE_FD", "0");
				const resolveBinary = vi.fn(() => sentinel);
				const consumeContract = vi.fn();
				expect(getProcessOwnership()).toEqual({ enabled: false });
				expect(ownershipDisabled([])).toBe(true);
				expect(resolveProcwardBinary()).toBeUndefined();
				expect(ownCliProcess([], { resolveBinary, consumeContract })).toBeUndefined();
				expect(resolveBinary).not.toHaveBeenCalled();
				expect(consumeContract).not.toHaveBeenCalled();
				expect(process.env.PI_PROCWARD_BOOTSTRAP_NONCE).toBeUndefined();
				expect(process.env.PI_NO_PROCESS_OWNERSHIP).toBeUndefined();
				expect(process.env.PROCWARD_PROTOCOL).toBe("invalid");
				expect(existsSync(log)).toBe(false);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	test("SDK defaults register no process tools or wrappers, without a runtime opt-out", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-off-sdk-"));
		vi.stubEnv("PI_NO_PROCESS_OWNERSHIP", undefined);
		vi.stubEnv("PI_PROCWARD_BIN", "/invalid/helper");
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: join(directory, "agent"),
			sessionManager: SessionManager.inMemory(directory),
		});
		try {
			expect(session.getAllTools().some((tool) => tool.name.startsWith("process_"))).toBe(false);
			const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
			const result = await bash.execute("direct", { command: "printf artifact-off" });
			expect(result.content).toEqual([{ type: "text", text: "artifact-off" }]);
		} finally {
			await session.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
