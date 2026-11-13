import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ExtensionFactory } from "../src/core/sdk.ts";
import { main } from "../src/main.ts";
import { allowNetwork } from "./test-network-env.ts";

function model(id: string, provider = "list-refresh-test"): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
	};
}

function catalogExtension(options: {
	cached?: Model<"openai-completions">;
	refreshed?: Model<"openai-completions">;
	failure?: Error;
	onNetworkRefresh?: () => void;
}): ExtensionFactory {
	return (pi) => {
		let models: readonly Model<"openai-completions">[] = options.cached ? [options.cached] : [];
		const provider: Provider<"openai-completions"> = {
			id: "list-refresh-test",
			name: "List refresh test",
			auth: {
				apiKey: {
					name: "Test API key",
					resolve: async () => ({ auth: { apiKey: "test-key" }, source: "test" }),
				},
			},
			getModels: () => models,
			refreshModels: async ({ allowNetwork, publish, stored }) => {
				const storedModels = stored?.models.filter(
					(model): model is Model<"openai-completions"> => model.api === "openai-completions",
				);
				if (storedModels && storedModels.length > 0) {
					await publish({
						update: () => {
							models = storedModels;
						},
					});
				}
				if (!allowNetwork) return;
				options.onNetworkRefresh?.();
				if (options.failure) throw options.failure;
				if (options.refreshed) {
					await publish({
						persist: { models: [options.refreshed], checkedAt: 1 },
						update: () => {
							models = [options.refreshed!];
						},
					});
				}
			},
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};
		pi.registerProvider(provider);
	};
}

describe("--list-models --refresh", () => {
	let tempDir: string;
	let originalAgentDir: string | undefined;
	let originalPiOffline: string | undefined;
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalPiOffline = process.env.PI_OFFLINE;
		originalExitCode = process.exitCode;
		allowNetwork();
		tempDir = mkdtempSync(join(tmpdir(), "pi-list-models-refresh-"));
		mkdirSync(join(tempDir, "agent"));
		process.env[ENV_AGENT_DIR] = join(tempDir, "agent");
		process.exitCode = undefined;
		vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			process.exitCode = code === undefined || code === null ? 0 : code;
			throw new Error(`process.exit(${process.exitCode})`);
		}) as typeof process.exit);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalAgentDir;
		if (originalPiOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = originalPiOffline;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("lists cached extension models without network refresh by default", async () => {
		let networkRefreshes = 0;
		const cached = model("cached-model");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(
			main(["--list-models"], {
				extensionFactories: [catalogExtension({ cached, onNetworkRefresh: () => networkRefreshes++ })],
			}),
		).rejects.toThrow("process.exit(0)");

		expect(networkRefreshes).toBe(0);
		expect(log.mock.calls.map(([message]) => String(message)).join("\n")).toContain(cached.id);
	});

	it("refreshes loaded extension providers before listing and persists their catalogs", async () => {
		let networkRefreshes = 0;
		const cached = model("cached-model");
		const refreshed = model("refreshed-model");
		const extensionFactory = catalogExtension({ cached, refreshed, onNetworkRefresh: () => networkRefreshes++ });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(
			main(["--list-models", "--refresh"], {
				extensionFactories: [extensionFactory],
			}),
		).rejects.toThrow("process.exit(0)");

		let output = log.mock.calls.map(([message]) => String(message)).join("\n");
		expect(networkRefreshes).toBe(1);
		expect(output).toContain(refreshed.id);
		expect(output).not.toContain(cached.id);

		process.exitCode = undefined;
		log.mockClear();
		await expect(
			main(["--list-models"], {
				extensionFactories: [extensionFactory],
			}),
		).rejects.toThrow("process.exit(0)");

		output = log.mock.calls.map(([message]) => String(message)).join("\n");
		expect(networkRefreshes).toBe(1);
		expect(output).toContain(refreshed.id);
		expect(output).not.toContain(cached.id);
	});

	it("lists refreshed and cached models but exits nonzero when one provider fails", async () => {
		const cached = model("cached-model");
		const refreshed = model("refreshed-model", "successful-list-refresh-test");
		const successfulExtension: ExtensionFactory = (pi) => {
			let models: readonly Model<"openai-completions">[] = [];
			pi.registerProvider({
				id: refreshed.provider,
				name: "Successful list refresh test",
				auth: {
					apiKey: {
						name: "Test API key",
						resolve: async () => ({ auth: { apiKey: "test-key" }, source: "test" }),
					},
				},
				getModels: () => models,
				refreshModels: async ({ allowNetwork, publish }) => {
					if (!allowNetwork) return;
					await publish({
						update: () => {
							models = [refreshed];
						},
					});
				},
				stream: () => {
					throw new Error("unused");
				},
				streamSimple: () => {
					throw new Error("unused");
				},
			});
		};
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			main(["--list-models", "--refresh"], {
				extensionFactories: [
					successfulExtension,
					catalogExtension({ cached, failure: new Error("catalog unavailable") }),
				],
			}),
		).rejects.toThrow("process.exit(1)");

		const output = log.mock.calls.map(([message]) => String(message)).join("\n");
		expect(output).toContain(refreshed.id);
		expect(output).toContain(cached.id);
		expect(error.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"list-refresh-test: catalog unavailable",
		);
	});

	it("keeps update --models extension-free", async () => {
		let extensionLoaded = false;
		const refresh = vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() }));
		vi.spyOn(ModelRuntime, "create").mockResolvedValue({ refresh } as unknown as ModelRuntime);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(
			main(["update", "--models"], {
				extensionFactories: [
					() => {
						extensionLoaded = true;
					},
				],
			}),
		).rejects.toThrow("process.exit(0)");

		expect(extensionLoaded).toBe(false);
		expect(refresh).toHaveBeenCalledWith({
			allowNetwork: true,
			force: true,
			signal: expect.any(AbortSignal),
		});
		expect(log.mock.calls.map(([message]) => String(message)).join("\n")).toContain("Model catalogs refreshed");
	});

	it("rejects refresh in offline mode before contacting providers", async () => {
		let networkRefreshes = 0;
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			main(["--list-models", "--refresh", "--offline"], {
				extensionFactories: [catalogExtension({ onNetworkRefresh: () => networkRefreshes++ })],
			}),
		).rejects.toThrow("process.exit(1)");

		expect(networkRefreshes).toBe(0);
		expect(error.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"--refresh cannot be used with --offline or PI_OFFLINE",
		);
	});
});
