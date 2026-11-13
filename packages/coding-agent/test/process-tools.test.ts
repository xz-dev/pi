import { describe, expect, test, vi } from "vitest";
import { createProcessRegistry, type OwnedCompletion } from "../src/core/process-registry.ts";
import { createProcessKillToolDefinition, type ProcessKillResult } from "../src/core/tools/process-kill.ts";
import { createProcessListToolDefinition, type ProcessListEntry } from "../src/core/tools/process-list.ts";

function text(result: { content: { type: string; text?: string }[] }) {
	const content = result.content.find((part) => part.type === "text");
	if (!content?.text) throw new Error("Missing text result");
	return JSON.parse(content.text) as { processes: ProcessListEntry[]; results: ProcessKillResult[] };
}

function deferred() {
	let resolve!: (completion: OwnedCompletion) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<OwnedCompletion>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("process tool schemas", () => {
	test("process_list and process_kill keep their model-facing schema", () => {
		const registry = createProcessRegistry();
		const schema = [createProcessListToolDefinition(registry), createProcessKillToolDefinition(registry)].map(
			(tool) =>
				JSON.parse(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })),
		);
		expect(schema).toMatchInlineSnapshot(`
			[
			  {
			    "description": "List owned process trees, including background work after its tool returns. Shows command, tool call/message provenance, procward PID, status and age. Session entry 0 identifies the current owner and cannot be cancelled; use process_kill for positive task IDs. Unconfirmed entries have not proved tree cleanup.",
			    "name": "process_list",
			    "parameters": {
			      "properties": {},
			      "type": "object",
			    },
			  },
			  {
			    "description": "Cancel one or more owned task trees through their native control endpoints, using the owner's configured grace. Reports each ID independently: confirmed cleanup includes primary exit status and kernel/best-effort scope; missing or invalid cleanup evidence is unconfirmed, never success. Unknown IDs are reported. Session entry 0 cannot be cancelled by this tool. Per-request grace overrides are not supported.",
			    "name": "process_kill",
			    "parameters": {
			      "properties": {
			        "ids": {
			          "description": "One or more positive task IDs from process_list. Session id 0 cannot be cancelled.",
			          "items": {
			            "minimum": 0,
			            "type": "integer",
			          },
			          "minItems": 1,
			          "type": "array",
			        },
			      },
			      "required": [
			        "ids",
			      ],
			      "type": "object",
			    },
			  },
			]
		`);
	});
});

describe("process_list", () => {
	test("lists the session owner first, then running and background tasks by start time", async () => {
		vi.useFakeTimers({ now: 10_000 });
		try {
			const registry = createProcessRegistry(4242);
			vi.setSystemTime(11_000);
			const service = registry.register({
				command: "npm run dev &",
				purpose: "bash tool call call-1",
				provenance: { toolName: "bash", toolCallId: "call-1", messageId: "m1", messageSummary: "Start" },
				procwardPid: 101,
				cancel: vi.fn(),
			});
			registry.settle(service.id, { descendantsAlive: true, unconfirmed: false });
			vi.setSystemTime(12_000);
			const tests = registry.register({
				command: "npm test",
				purpose: "bash tool call call-2",
				procwardPid: 102,
				cancel: vi.fn(),
			});
			vi.setSystemTime(14_000);
			const { processes } = text(
				await createProcessListToolDefinition(registry).execute(
					"list",
					{},
					undefined,
					undefined,
					undefined as never,
				),
			);
			expect(
				processes.map((entry) => [entry.id, entry.kind, entry.status, entry.procwardPid, entry.ageSeconds]),
			).toEqual([
				[0, "session", "running", 4242, 4],
				[service.id, "task", "background", 101, 3],
				[tests.id, "task", "running", 102, 2],
			]);
			expect(processes[1]).toMatchObject({
				command: "npm run dev &",
				purpose: "bash tool call call-1",
				provenance: { toolName: "bash", toolCallId: "call-1", messageId: "m1", messageSummary: "Start" },
			});
			expect(processes[2]).not.toHaveProperty("provenance");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("process_kill status transitions", () => {
	test("a task is reaping while its owner cancels, then confirmed cleanup lets settle remove it", async () => {
		const registry = createProcessRegistry();
		const cancel = deferred();
		const task = registry.register({
			command: "sleep 999 &",
			purpose: "bash",
			procwardPid: 7,
			cancel: () => cancel.promise,
		});
		expect(task.status).toBe("running");
		const kill = createProcessKillToolDefinition(registry).execute(
			"kill",
			{ ids: [task.id] },
			undefined,
			undefined,
			undefined as never,
		);
		expect(registry.get(task.id)?.status).toBe("reaping");
		cancel.resolve({ exitCode: 143, scope: "kernel", unconfirmed: false });
		expect(text(await kill).results).toEqual([
			{ id: task.id, status: "confirmed", exitCode: 143, scope: "kernel", unconfirmed: false },
		]);
		expect(registry.get(task.id)?.status).toBe("reaping");
		registry.settle(task.id, { descendantsAlive: false, unconfirmed: false });
		expect(registry.get(task.id)).toBeUndefined();
	});

	test("missing cleanup evidence and a failed cancel both leave the task unconfirmed", async () => {
		const registry = createProcessRegistry();
		const incomplete = registry.register({
			command: "a",
			purpose: "bash",
			procwardPid: 8,
			cancel: async () => ({ exitCode: undefined, scope: undefined, unconfirmed: true }),
		});
		const failed = deferred();
		const broken = registry.register({ command: "b", purpose: "bash", procwardPid: 9, cancel: () => failed.promise });
		const kill = createProcessKillToolDefinition(registry).execute(
			"kill",
			{ ids: [incomplete.id, broken.id] },
			undefined,
			undefined,
			undefined as never,
		);
		expect(registry.get(broken.id)?.status).toBe("reaping");
		failed.reject(new Error("control channel closed"));
		expect(text(await kill).results.map((result) => result.status)).toEqual(["unconfirmed", "unconfirmed"]);
		expect(registry.get(incomplete.id)?.status).toBe("unconfirmed");
		expect(registry.get(broken.id)?.status).toBe("unconfirmed");
	});
});
