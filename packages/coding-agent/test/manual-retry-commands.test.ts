import { describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcCommand } from "../src/modes/rpc/rpc-types.ts";

describe("manual retry commands", () => {
	it("lists /retry as a built-in slash command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "retry",
			description: "Continue from the nearest safe conversation boundary",
		});
	});

	it("includes retry in the RPC command protocol", () => {
		const command = { type: "retry" } satisfies RpcCommand;
		expect(command.type).toBe("retry");
	});

	it("sends retry through RpcClient", async () => {
		const client = Object.create(RpcClient.prototype) as RpcClient;
		const send = vi.fn(async () => ({ id: "retry", type: "response", command: "retry", success: true }));
		Reflect.set(client, "send", send);

		await client.retry();

		expect(send).toHaveBeenCalledWith({ type: "retry" });
	});
});
