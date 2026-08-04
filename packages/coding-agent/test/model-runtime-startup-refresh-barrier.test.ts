import {
	type Api,
	InMemoryModelsStore,
	type Model,
	type ModelsStoreEntry,
	type ModelsStoreOperationOptions,
	type Provider,
} from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { LoadExtensionsResult } from "../src/core/extensions/types.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const storedModel: Model<"openai-completions"> = {
	id: "stored-native-model",
	name: "Stored native model",
	api: "openai-completions",
	provider: "startup-native",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000,
	maxTokens: 100,
};

class BarrierModelsStore extends InMemoryModelsStore {
	readonly firstTargetReadStarted = deferred();
	readonly secondTargetReadStarted = deferred();
	readonly releaseFirstTargetRead = deferred();
	readonly releaseSecondTargetRead = deferred();
	private targetReads = 0;

	override async read(
		providerId: string,
		options?: ModelsStoreOperationOptions,
	): Promise<ModelsStoreEntry | undefined> {
		if (providerId === storedModel.provider) {
			this.targetReads += 1;
			if (this.targetReads === 1) {
				this.firstTargetReadStarted.resolve();
				await this.releaseFirstTargetRead.promise;
			} else if (this.targetReads === 2) {
				this.secondTargetReadStarted.resolve();
				await this.releaseSecondTargetRead.promise;
			}
		}
		return super.read(providerId, options);
	}
}

function makeNativeProvider(models: { current: readonly Model<Api>[] }, onPublished?: () => void): Provider {
	return {
		id: storedModel.provider,
		name: "Startup native",
		auth: {},
		getModels: () => models.current,
		refreshModels: async ({ stored, publish }) => {
			if (!stored) return;
			await publish({
				update: () => {
					models.current = stored.models;
					onPublished?.();
				},
			});
		},
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

function extensionResultWithNativeProvider(provider: Provider): LoadExtensionsResult {
	const runtime = createExtensionRuntime();
	runtime.pendingNativeProviderRegistrations.push({ provider, extensionPath: "<startup-native>" });
	return { extensions: [], errors: [], runtime };
}

it("makes a stored native model visible before the startup-awaited refresh resolves", async () => {
	const modelsStore = new BarrierModelsStore();
	await modelsStore.write(storedModel.provider, { models: [storedModel] });
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore,
		modelsPath: null,
		allowModelNetwork: false,
	});

	const detachedConfigLoadStarted = deferred();
	const releaseDetachedConfigLoad = deferred();
	const detachedModelPublished = deferred();
	const originalLoad = ModelConfig.load;
	let configLoadCalls = 0;
	const loadSpy = vi.spyOn(ModelConfig, "load").mockImplementation(async (modelsPath: string | undefined) => {
		configLoadCalls += 1;
		if (configLoadCalls === 1) {
			detachedConfigLoadStarted.resolve();
			await releaseDetachedConfigLoad.promise;
		}
		return originalLoad.call(ModelConfig, modelsPath);
	});

	const models = { current: [] as readonly Model<Api>[] };
	const provider = makeNativeProvider(models, () => detachedModelPublished.resolve());

	try {
		runtime.registerNativeProvider(provider);
		await detachedConfigLoadStarted.promise;

		// Startup barrier must wait for the registration-triggered refresh still held in ModelConfig.load.
		const startupRefresh = runtime.refreshAfterRegistrationConvergence({ allowNetwork: false });
		let startupSettled = false;
		void startupRefresh.then(
			() => {
				startupSettled = true;
			},
			() => {
				startupSettled = true;
			},
		);
		await Promise.resolve();
		expect(startupSettled).toBe(false);
		expect(runtime.getModel(storedModel.provider, storedModel.id)).toBeUndefined();

		// Registration refresh proceeds alone: config load → first store read → publish → settle.
		releaseDetachedConfigLoad.resolve();
		await modelsStore.firstTargetReadStarted.promise;
		modelsStore.releaseFirstTargetRead.resolve();
		await detachedModelPublished.promise;

		// Barrier's own refresh then hits the second store read.
		await modelsStore.secondTargetReadStarted.promise;
		modelsStore.releaseSecondTargetRead.resolve();

		const result = await startupRefresh;
		expect(result).toMatchObject({ aborted: false, errors: new Map() });
		expect(runtime.getModel(storedModel.provider, storedModel.id)).toBeDefined();
	} finally {
		releaseDetachedConfigLoad.resolve();
		modelsStore.releaseFirstTargetRead.resolve();
		modelsStore.releaseSecondTargetRead.resolve();
		loadSpy.mockRestore();
	}
});

it("makes session services wait for cached native models and forward startup cancellation", async () => {
	const modelsStore = new InMemoryModelsStore();
	await modelsStore.write(storedModel.provider, { models: [storedModel] });
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore,
		modelsPath: null,
		allowModelNetwork: false,
	});

	const registrationRefreshStarted = deferred();
	const releaseRegistrationRefresh = deferred();
	const published = deferred();
	const originalLoad = ModelConfig.load;
	let loadCalls = 0;
	const loadSpy = vi.spyOn(ModelConfig, "load").mockImplementation(async (modelsPath: string | undefined) => {
		loadCalls += 1;
		if (loadCalls === 1) {
			registrationRefreshStarted.resolve();
			await releaseRegistrationRefresh.promise;
		}
		return originalLoad.call(ModelConfig, modelsPath);
	});

	const models = { current: [] as readonly Model<Api>[] };
	const provider = makeNativeProvider(models, () => published.resolve());
	const extensions = extensionResultWithNativeProvider(provider);
	const controller = new AbortController();

	try {
		const services = createAgentSessionServices({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			modelRuntime: runtime,
			modelRuntimeSignal: controller.signal,
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionsOverride: () => extensions,
			},
		});
		await registrationRefreshStarted.promise;
		expect(runtime.getModel(storedModel.provider, storedModel.id)).toBeUndefined();

		controller.abort();
		await expect(services).rejects.toMatchObject({ name: "AbortError" });

		releaseRegistrationRefresh.resolve();
		await published.promise;
		expect(runtime.getModel(storedModel.provider, storedModel.id)).toBeDefined();
	} finally {
		releaseRegistrationRefresh.resolve();
		loadSpy.mockRestore();
	}
});

it("does not let a failed registration convergence poison a later registration", async () => {
	const modelsStore = new InMemoryModelsStore();
	await modelsStore.write(storedModel.provider, { models: [storedModel] });
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore,
		modelsPath: null,
		allowModelNetwork: false,
	});

	const originalLoad = ModelConfig.load;
	let loadCalls = 0;
	const loadSpy = vi.spyOn(ModelConfig, "load").mockImplementation(async (modelsPath: string | undefined) => {
		loadCalls += 1;
		// First registration-triggered refresh fails; later loads succeed.
		if (loadCalls === 1) {
			throw new Error("registration refresh failed");
		}
		return originalLoad.call(ModelConfig, modelsPath);
	});

	const models = { current: [] as readonly Model<Api>[] };
	const published = deferred();
	const provider = makeNativeProvider(models, () => published.resolve());

	try {
		// First registration queues a failing convergence refresh.
		runtime.registerNativeProvider({
			...provider,
			id: "failing-native",
			getModels: () => [],
			refreshModels: async () => {},
		});
		// Second registration must still converge after the failed tail.
		runtime.registerNativeProvider(provider);

		const result = await runtime.refreshAfterRegistrationConvergence({ allowNetwork: false });
		expect(result).toMatchObject({ aborted: false, errors: new Map() });
		await published.promise;
		expect(runtime.getModel(storedModel.provider, storedModel.id)).toBeDefined();
	} finally {
		loadSpy.mockRestore();
	}
});

it("aborts the startup barrier promptly while registration convergence continues", async () => {
	const modelsStore = new InMemoryModelsStore();
	await modelsStore.write(storedModel.provider, { models: [storedModel] });
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore,
		modelsPath: null,
		allowModelNetwork: false,
	});

	const detachedConfigLoadStarted = deferred();
	const releaseDetachedConfigLoad = deferred();
	const detachedModelPublished = deferred();
	const originalLoad = ModelConfig.load;
	let configLoadCalls = 0;
	const loadSpy = vi.spyOn(ModelConfig, "load").mockImplementation(async (modelsPath: string | undefined) => {
		configLoadCalls += 1;
		if (configLoadCalls === 1) {
			detachedConfigLoadStarted.resolve();
			await releaseDetachedConfigLoad.promise;
		}
		return originalLoad.call(ModelConfig, modelsPath);
	});

	const models = { current: [] as readonly Model<Api>[] };
	const provider = makeNativeProvider(models, () => detachedModelPublished.resolve());

	try {
		runtime.registerNativeProvider(provider);
		await detachedConfigLoadStarted.promise;

		const controller = new AbortController();
		const startupRefresh = runtime.refreshAfterRegistrationConvergence({
			allowNetwork: false,
			signal: controller.signal,
		});
		controller.abort();

		await expect(startupRefresh).rejects.toMatchObject({ name: "AbortError" });
		expect(runtime.getModel(storedModel.provider, storedModel.id)).toBeUndefined();

		// Registration convergence must continue after the caller abandoned the barrier wait.
		releaseDetachedConfigLoad.resolve();
		await detachedModelPublished.promise;
		expect(runtime.getModel(storedModel.provider, storedModel.id)).toBeDefined();
	} finally {
		releaseDetachedConfigLoad.resolve();
		loadSpy.mockRestore();
	}
});

it("applies register then unregister in order so the final state is unregistered", async () => {
	const modelsStore = new InMemoryModelsStore();
	await modelsStore.write(storedModel.provider, { models: [storedModel] });
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore,
		modelsPath: null,
		allowModelNetwork: false,
	});

	const firstRefreshStarted = deferred();
	const releaseFirstRefresh = deferred();
	const originalLoad = ModelConfig.load;
	let loadCalls = 0;
	const loadSpy = vi.spyOn(ModelConfig, "load").mockImplementation(async (modelsPath: string | undefined) => {
		loadCalls += 1;
		// Hold only the first registration-triggered refresh so unregister queues behind it.
		if (loadCalls === 1) {
			firstRefreshStarted.resolve();
			await releaseFirstRefresh.promise;
		}
		return originalLoad.call(ModelConfig, modelsPath);
	});

	const models = { current: [] as readonly Model<Api>[] };
	const provider = makeNativeProvider(models);

	try {
		runtime.registerNativeProvider(provider);
		await firstRefreshStarted.promise;
		runtime.unregisterProvider(storedModel.provider);

		releaseFirstRefresh.resolve();
		const result = await runtime.refreshAfterRegistrationConvergence({ allowNetwork: false });
		expect(result).toMatchObject({ aborted: false, errors: new Map() });
		expect(runtime.getModel(storedModel.provider, storedModel.id)).toBeUndefined();
		expect(runtime.getProviders().some((entry) => entry.id === storedModel.provider)).toBe(false);
	} finally {
		releaseFirstRefresh.resolve();
		loadSpy.mockRestore();
	}
});
