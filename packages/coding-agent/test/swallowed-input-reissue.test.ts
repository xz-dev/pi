import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function userOrigins(harness: Harness): (AgentMessage & { role: "user" })[] {
	return harness.events
		.filter((e): e is Extract<AgentSessionEvent, { type: "message_end" }> => e.type === "message_end")
		.map((e) => e.message)
		.filter((m): m is AgentMessage & { role: "user" } => m.role === "user");
}

describe("swallowed input re-issue attribution", () => {
	it("attributes an extension-re-issued swallowed input to its original origin", async () => {
		// The takeover pattern: swallow once (guarded like the watchdog's isReissuedTakeover),
		// re-issue verbatim via sendUserMessage when idle.
		let swallowed = false;
		let reissue: ((text: string) => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (!swallowed && event.source === "interactive" && event.text === "TAKEOVER") {
							swallowed = true;
							reissue = (text) => pi.sendUserMessage(text);
							return { action: "handled" };
						}
						return { action: "continue" };
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("TAKEOVER", { source: "interactive" });
		// The swallowed prompt produced no turn.
		expect(userOrigins(harness)).toHaveLength(0);

		reissue!("TAKEOVER");
		await expect.poll(() => userOrigins(harness)).toHaveLength(1);
		expect(userOrigins(harness)[0].origin).toEqual({ type: "interactive" });
		harness.cleanup();
	});

	it("keeps a fresh extension sendUserMessage attributed to the extension", async () => {
		let send: ((text: string) => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					send = (text) => pi.sendUserMessage(text);
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("ok1"), fauxAssistantMessage("ok2")]);
		await harness.session.prompt("start", { source: "interactive" });
		send!("extension-authored");
		await expect.poll(() => userOrigins(harness).length).toBe(2);
		expect(userOrigins(harness)[1].origin?.type).toBe("extension");
		harness.cleanup();
	});

	it("does not claim a delivered interactive input identical to extension content", async () => {
		let send: ((text: string) => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					send = (text) => pi.sendUserMessage(text);
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("ok1"), fauxAssistantMessage("ok2")]);
		// "plain text" is delivered normally (never swallowed); only handled inputs are claimable.
		await harness.session.prompt("plain text", { source: "interactive" });
		send!("plain text");
		await expect.poll(() => userOrigins(harness).length).toBe(2);
		expect(userOrigins(harness)[1].origin?.type).toBe("extension");
		harness.cleanup();
	});
});
