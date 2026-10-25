import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { forkDriver } from "../../chord/src/manager.ts";
import { StdioTransport } from "../../mcp/src/transports/stdio.ts";
import { execCommand } from "../src/core/exec.ts";
import { createLocalShellOperations } from "../src/core/tools/bash.ts";

const binary = process.env.PI_PROCESS_OWNER_TEST_BINARY;
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
const probe = `
import { execFileSync } from "node:child_process";
const identity = pid => execFileSync("ps", ["-p", String(pid), "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "sid="], { encoding: "utf8" }).trim().split(/\\s+/).map(Number);
const payload = identity(process.pid);
const guardian = identity(payload[1]);
const outer = identity(guardian[1]);
const record = { payload, guardian, outer };
if (process.send) { process.send(record); process.disconnect(); }
else console.log(JSON.stringify(process.env.PI_GROUPS_MCP ? { jsonrpc: "2.0", method: "identity", params: record } : record));
`;

describe.skipIf(!binary || (process.platform !== "linux" && process.platform !== "freebsd"))(
	"native task groups",
	() => {
		for (const caller of ["exec", "bash", "chord", "mcp"] as const) {
			it(`${caller} isolates task PG without leaving caller SID`, async () => {
				const previous = process.env.PI_PROCESS_OWNER_BINARY;
				process.env.PI_PROCESS_OWNER_BINARY = binary;
				const directory = mkdtempSync(join(tmpdir(), "owner-groups-"));
				try {
					const parent = execFileSync("ps", ["-p", String(process.pid), "-o", "pgid=", "-o", "sid="], {
						encoding: "utf8",
					})
						.trim()
						.split(/\s+/)
						.map(Number);
					let record: { payload: number[]; guardian: number[]; outer: number[] } | undefined;
					if (caller === "mcp") {
						const transport = new StdioTransport({
							command: process.execPath,
							args: ["--input-type=module", "-e", probe],
							env: { PI_GROUPS_MCP: "1" },
						});
						const message = new Promise<void>((resolve, reject) => {
							transport.onError(reject);
							transport.onMessage((message) => {
								if ("params" in message) record = message.params as NonNullable<typeof record>;
								resolve();
							});
						});
						try {
							await Promise.all([transport.start(), message]);
						} finally {
							await transport.close();
						}
					} else if (caller === "chord") {
						const entry = join(directory, "probe.mjs");
						writeFileSync(entry, probe);
						const child = forkDriver({
							entry,
							onMessage: (message) => {
								record = message as NonNullable<typeof record>;
							},
						}).spawn();
						assert.deepEqual(await child.exited, { code: 0, signal: null });
					} else {
						let stdout = "";
						if (caller === "exec") {
							const result = await execCommand(
								process.execPath,
								["--input-type=module", "-e", probe],
								directory,
							);
							assert.equal(result.code, 0, result.stderr);
							stdout = result.stdout;
						} else {
							const result = await createLocalShellOperations("sh", () => ({
								shell: "/bin/sh",
								args: ["-c"],
							})).exec(`exec ${quote(process.execPath)} --input-type=module -e ${quote(probe)}`, directory, {
								onData: (chunk) => {
									stdout += chunk.toString();
								},
							});
							assert.equal(result.exitCode, 0, stdout);
						}
						record = JSON.parse(stdout);
					}
					assert.ok(record);
					process.stderr.write(`task group identity=${JSON.stringify({ caller, parent, record })}\n`);
					assert.notEqual(record.outer[2], parent[0], JSON.stringify({ caller, parent, record }));
					assert.equal(record.outer[2], record.outer[0], "task outer must lead its private group");
					for (const role of [record.outer, record.guardian, record.payload]) {
						assert.equal(role[2], record.outer[0], "task roles must share isolated group");
						assert.equal(role[3], parent[1], JSON.stringify({ caller, parent, record }));
					}
				} finally {
					if (previous === undefined) delete process.env.PI_PROCESS_OWNER_BINARY;
					else process.env.PI_PROCESS_OWNER_BINARY = previous;
					rmSync(directory, { recursive: true, force: true });
				}
			});
		}
	},
);
