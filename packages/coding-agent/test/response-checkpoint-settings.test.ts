import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { closeOpenAIResponsesWebSocketSessions } from "@earendil-works/pi-ai/api/openai-responses";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

let dir: string;
let cwd: string;
let agentDir: string;
let globalPath: string;
let projectPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-settings-"));
	cwd = join(dir, "project");
	agentDir = join(dir, "agent");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir);
	globalPath = join(agentDir, "settings.json");
	projectPath = join(cwd, ".pi", "settings.json");
});

afterEach(() => {
	closeOpenAIResponsesWebSocketSessions();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

function writeSettings(path: string, raw: unknown): void {
	writeFileSync(path, JSON.stringify({ responseCheckpointExclude: raw }));
}

describe("raw response checkpoint settings", () => {
	it.each([undefined, [], ["*"], ["openai/**", "gpt-[45]*"], null, ["unrelated", 7], "*"].map((raw) => ({ raw })))(
		"preserves $raw through unrelated save, reload and restart",
		async ({ raw }) => {
			writeSettings(globalPath, raw);
			writeSettings(projectPath, undefined);
			const settings = SettingsManager.create(cwd, agentDir);
			expect(settings.getResponseCheckpointExclude()).toEqual(raw);
			settings.setTheme("dark");
			settings.setProjectSkillPaths([]);
			await settings.flush();
			await settings.reload();
			expect(settings.drainErrors()).toEqual([]);
			expect(settings.getResponseCheckpointExclude()).toEqual(raw);
			const saved = JSON.parse(readFileSync(globalPath, "utf8"));
			expect(saved).toEqual(
				raw === undefined ? { theme: "dark" } : { theme: "dark", responseCheckpointExclude: raw },
			);
			expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({ skills: [] });
			expect(SettingsManager.create(cwd, agentDir).getResponseCheckpointExclude()).toEqual(raw);
		},
	);

	it.each([[], ["*"], ["gateway/**"], null, [4]].map((raw) => ({ raw })))(
		"uses trusted project $raw instead of global list",
		async ({ raw }) => {
			writeSettings(globalPath, ["global/**"]);
			writeSettings(projectPath, raw);
			const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
			expect(settings.getResponseCheckpointExclude()).toEqual(["global/**"]);
			settings.setProjectTrusted(true);
			expect(settings.getResponseCheckpointExclude()).toEqual(raw);
			settings.setTheme("light");
			settings.setProjectSkillPaths([]);
			await settings.flush();
			await settings.reload();
			expect(settings.drainErrors()).toEqual([]);
			expect(settings.getResponseCheckpointExclude()).toEqual(raw);
			expect(JSON.parse(readFileSync(globalPath, "utf8")).responseCheckpointExclude).toEqual(["global/**"]);
			expect(JSON.parse(readFileSync(projectPath, "utf8")).responseCheckpointExclude).toEqual(raw);
			expect(SettingsManager.create(cwd, agentDir).getResponseCheckpointExclude()).toEqual(raw);
			settings.setProjectTrusted(false);
			expect(settings.getResponseCheckpointExclude()).toEqual(["global/**"]);
		},
	);
});

interface Frame {
	store: boolean;
	input: unknown[];
	previous_response_id?: string;
}

describe("native session checkpoint requests over loopback WebSocket", () => {
	it.each([
		{ raw: undefined, enabled: false },
		{ raw: [], enabled: true },
		{ raw: ["*"], enabled: false },
		{ raw: ["CHECKPOINT-LOCAL"], enabled: false },
		{ raw: ["checkpoint-local/**"], enabled: false },
		{ raw: ["gpt-[45]*"], enabled: false },
		{ raw: ["unrelated/**"], enabled: true },
		{ raw: null, enabled: false },
		{ raw: ["unrelated", 7], enabled: false },
	])("raw $raw yields store/capture $enabled through session.prompt", async ({ raw, enabled }) => {
		const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await new Promise<void>((resolve) => server.once("listening", resolve));
		vi.stubGlobal("WebSocket", WebSocket);
		const frames: Frame[] = [];
		const stored = new Set<string>();
		server.on("connection", (socket) => {
			const connectionResponses = new Set<string>();
			socket.on("message", (data) => {
				const frame: Frame = JSON.parse(data.toString());
				frames.push(frame);
				if (
					frame.previous_response_id &&
					!stored.has(frame.previous_response_id) &&
					!connectionResponses.has(frame.previous_response_id)
				) {
					socket.send(
						JSON.stringify({ type: "error", error: { code: "previous_response_not_found", message: "missing" } }),
					);
					return;
				}
				const id = `resp_local_${frames.length}`;
				const item = {
					type: "message",
					id: `msg_local_${frames.length}`,
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "local answer", annotations: [] }],
				};
				connectionResponses.add(id);
				if (frame.store) stored.add(id);
				for (const event of [
					{ type: "response.created", response: { id } },
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { ...item, content: [], status: "in_progress" },
					},
					{ type: "response.output_item.done", output_index: 0, item },
					{
						type: "response.completed",
						response: { id, status: "completed", output: [item], store: frame.store },
					},
				])
					socket.send(JSON.stringify(event));
			});
		});
		const model: Model<"openai-responses"> = {
			id: "gpt-5-local",
			name: "Local",
			provider: "checkpoint-local",
			api: "openai-responses",
			baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			compat: { supportsResponseCheckpoints: true },
		};
		writeSettings(globalPath, raw);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const credentials = AuthStorage.inMemory();
		await credentials.modify(model.provider, async () => ({ type: "api_key", key: "dummy-loopback-key" }));
		const registry = await createModelRegistry(credentials);
		registry.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "dummy-loopback-key",
		});
		const modelRuntime = getModelRuntime(registry);
		const requests = vi.spyOn(modelRuntime, "streamSimple");
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			systemPromptOverride: () => "Local checkpoint test",
		});
		await resourceLoader.reload();
		const options = { cwd, agentDir, model, modelRuntime, resourceLoader, settingsManager, tools: [] };
		const { session } = await createAgentSession(options);
		try {
			await session.prompt("first local question");
			expect(session.agent.state.errorMessage).toBeUndefined();
			expect(frames).toHaveLength(1);
			expect(frames[0].store).toBe(enabled);
			expect(requests.mock.calls[0][2]?.responseCheckpointExclude).toEqual(raw);
			const assistant = session.messages.find((message) => message.role === "assistant");
			expect(assistant?.role).toBe("assistant");
			if (assistant?.role !== "assistant") throw new Error("Missing assistant");
			expect(assistant.stopReason).toBe("stop");
			expect(assistant.content).toEqual([expect.objectContaining({ type: "text", text: "local answer" })]);
			expect(!!assistant.responseCheckpoint).toBe(enabled);
			const file = session.sessionFile!;
			const canonical = structuredClone(session.messages);
			session.dispose();
			closeOpenAIResponsesWebSocketSessions();
			const restored = SessionManager.open(file);
			expect(restored.buildSessionContext().messages).toEqual(canonical);
			expect(readFileSync(file, "utf8")).not.toContain("dummy-loopback-key");

			// A new public session uses canonical JSONL, not an in-memory socket prefix.
			settingsManager.setTheme("dark");
			await settingsManager.flush();
			const restartedSettings = SettingsManager.create(cwd, agentDir);
			expect(restartedSettings.getResponseCheckpointExclude()).toEqual(raw);
			const { session: reopened } = await createAgentSession({
				...options,
				settingsManager: restartedSettings,
				sessionManager: restored,
			});
			try {
				await reopened.prompt("second local question");
				expect(reopened.agent.state.errorMessage).toBeUndefined();
				expect(frames).toHaveLength(2);
				expect(frames[1].store).toBe(enabled);
				expect(frames[1].previous_response_id).toBe(enabled ? assistant.responseId : undefined);
				if (enabled) {
					// Continuation sends exactly one user message containing the new text.
					// patch/message-origin may prepend a source label input_text, so assert
					// the real property: one user item that includes the new question and
					// no full-history replay of the first question.
					expect(frames[1].input).toHaveLength(1);
					expect((frames[1].input[0] as { role?: string }).role).toBe("user");
					expect(JSON.stringify(frames[1].input)).toContain("second local question");
					expect(JSON.stringify(frames[1].input)).not.toContain("first local question");
				} else {
					expect(JSON.stringify(frames[1].input)).toContain("first local question");
					expect(JSON.stringify(frames[1].input)).toContain("local answer");
				}
				writeSettings(projectPath, ["*"]);
				await restartedSettings.reload();
				await reopened.prompt("trusted project exclusion");
				expect(reopened.agent.state.errorMessage).toBeUndefined();
				expect(frames).toHaveLength(3);
				expect(frames[2].store).toBe(false);
				expect(requests.mock.calls[2][2]?.responseCheckpointExclude).toEqual(["*"]);

				writeSettings(projectPath, []);
				await restartedSettings.reload();
				await reopened.prompt("trusted project opt-in");
				expect(reopened.agent.state.errorMessage).toBeUndefined();
				expect(frames).toHaveLength(4);
				expect(frames[3].store).toBe(true);
				expect(requests.mock.calls[3][2]?.responseCheckpointExclude).toEqual([]);

				restartedSettings.setProjectTrusted(false);
				await reopened.prompt("global policy after revoking trust");
				expect(reopened.agent.state.errorMessage).toBeUndefined();
				expect(frames).toHaveLength(5);
				expect(frames[4].store).toBe(enabled);
				expect(requests.mock.calls[4][2]?.responseCheckpointExclude).toEqual(raw);
			} finally {
				reopened.dispose();
			}
		} finally {
			session.dispose();
			closeOpenAIResponsesWebSocketSessions();
			for (const socket of server.clients) socket.terminate();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
