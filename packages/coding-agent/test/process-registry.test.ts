import { describe, expect, test, vi } from "vitest";
import { createProcessRegistry } from "../src/core/process-registry.ts";

describe("process registry", () => {
	test("register assigns ids in order and lists by start time", () => {
		const registry = createProcessRegistry();
		const first = registry.register({ command: "npm dev", purpose: "bash tool", procwardPid: 10, cancel: vi.fn() });
		const second = registry.register({ command: "pytest", purpose: "bash tool", procwardPid: 11, cancel: vi.fn() });
		expect(first.id).toBeLessThan(second.id);
		expect(registry.list().map((t) => t.id)).toEqual([first.id, second.id]);
		expect(registry.get(first.id)).toBe(first);
	});

	test("settle with live descendants keeps a background entry", () => {
		const registry = createProcessRegistry();
		const task = registry.register({ command: "cmd &", purpose: "bash tool", procwardPid: 10, cancel: vi.fn() });
		registry.settle(task.id, { descendantsAlive: true, unconfirmed: false });
		expect(registry.get(task.id)?.status).toBe("background");
	});

	test("settle clean removes the entry", () => {
		const registry = createProcessRegistry();
		const task = registry.register({ command: "ls", purpose: "bash tool", procwardPid: 10, cancel: vi.fn() });
		registry.settle(task.id, { descendantsAlive: false, unconfirmed: false });
		expect(registry.get(task.id)).toBeUndefined();
	});

	test("unconfirmed cleanup keeps the entry for inspection", () => {
		const registry = createProcessRegistry();
		const task = registry.register({ command: "x", purpose: "bash tool", procwardPid: 10, cancel: vi.fn() });
		registry.settle(task.id, { descendantsAlive: false, unconfirmed: true });
		expect(registry.get(task.id)?.status).toBe("unconfirmed");
	});

	test("forget drops the entry unconditionally", () => {
		const registry = createProcessRegistry();
		const task = registry.register({ command: "x", purpose: "bash tool", procwardPid: 10, cancel: vi.fn() });
		registry.forget(task.id);
		expect(registry.list()).toHaveLength(0);
	});

	test("self ownership is carried for process_list", () => {
		const registry = createProcessRegistry(4242);
		expect(registry.selfProcwardPid).toBe(4242);
	});
});
