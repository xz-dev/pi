import { writeSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { getProcessOwnership, ownCliProcess, processShutdownPending } from "../../src/utils/procward.ts";

// Protocol-only child: no procward, real model requests, terminal or process-group signals.
const scenario = process.argv[2];
const now = () => performance.timeOrigin + performance.now();
const record = (event: string, details: Record<string, unknown> = {}) => {
	writeSync(4, `${JSON.stringify({ event, at: now(), ...details })}\n`);
};

// Observe configured main timers without changing their clock, callback or duration.
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
	if (delay !== undefined && delay > 100 && delay <= 5000) {
		record("timer", { delay, observationOrigin: now() + delay - 5000 });
	}
	return originalSetTimeout(callback, delay, ...args);
}) as typeof setTimeout;

// Native TERM may arrive before worker message delivery. Delay only that delivery,
// not the worker reader/watchdog or the shared observation, to exercise this order.
if (scenario === "cont-before-message") {
	const emit = Worker.prototype.emit;
	Worker.prototype.emit = function (event: string | symbol, ...args: unknown[]): boolean {
		if (event === "message") {
			record("message-held");
			originalSetTimeout(() => {
				record("message-delivered");
				emit.call(this, event, ...args);
			}, 300);
			return true;
		}
		return emit.call(this, event, ...args);
	};
}

ownCliProcess([], {
	resolveBinary: () => {
		throw new Error("must use validated controlled handoff");
	},
});
if (!getProcessOwnership().enabled || process.env.PI_NO_PROCESS_OWNERSHIP === "1") {
	throw new Error("fixture did not enable production ownership");
}
record("observer-ready", { enabled: getProcessOwnership().enabled });
const keepAlive = setInterval(() => {}, 1000);
if (scenario === "startup") {
	// No mode or hook exists yet; the default SIGTERM bridge must still close the process.
	record("mode-ready");
} else {
	const directory = process.env.PI_FIXTURE_DIRECTORY!;
	const faux = registerFauxProvider();
	const credentials = AuthStorage.inMemory();
	await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: `${directory}/models.json` });
	const model = faux.getModel();
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
	const extension: ExtensionFactory = (pi) => {
		pi.on("session_shutdown", async () => {
			record("hook-start");
			if (scenario === "cpu-hook" || scenario === "already-closing-cpu")
				while (true) {
					/* controlled worker-watchdog fixture */
				}
			if (!["healthy", "healthy-cont", "cont-before-message", "quick", "credential-wait"].includes(scenario)) {
				await new Promise(() => {});
			}
			record("hook-end");
		});
	};
	const host = await createAgentSessionRuntime(
		async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: directory,
				modelRuntime,
				resourceLoaderOptions: {
					extensionFactories: [extension],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
				services,
				diagnostics: services.diagnostics,
			};
		},
		{ cwd: directory, agentDir: directory, sessionManager: SessionManager.inMemory(directory) },
	);
	if (scenario === "abort-wait") {
		host.session.abort = async () => {
			record("abort-wait");
			await new Promise(() => {});
		};
	}
	if (scenario === "credential-wait") {
		modelRuntime.settleCredentialWrites = async () => {
			record("credential-wait");
			await new Promise(() => {});
		};
	}
	if (
		[
			"cont-before-message",
			"native-term-cont",
			"native-term-after-loss",
			"native-term-repeat",
			"native-term-before-loss",
			"healthy-cont",
		].includes(scenario)
	) {
		// Exercise the real suspend callback, but stub only the host group-stop operation.
		const originalKill = process.kill;
		process.kill = ((pid, signal) => {
			if (pid === 0 && signal === "SIGTSTP") return true;
			return originalKill(pid, signal);
		}) as typeof process.kill;
		const context = {
			isShuttingDown: false,
			shutdownRequested: false,
			ui: {
				stop() {
					record("ui-stop");
				},
				start() {
					record("ui-start");
				},
				requestRender() {
					record("ui-render");
				},
			},
		};
		const prototype = InteractiveMode.prototype as unknown as { handleCtrlZ(this: typeof context): void };
		prototype.handleCtrlZ.call(context);
		process.on("SIGCONT", () => record("cont-callback", { pending: processShutdownPending() }));
	}
	if (scenario.startsWith("print-") || scenario === "external-repeat-print") {
		// Print has already entered its shared final disposal when the peer injects loss.
		void runPrintMode(host, { mode: "json" });
	} else {
		void runRpcMode(host);
	}
	const ready = setInterval(() => {
		if (process.listenerCount("SIGTERM") === 0) return;
		clearInterval(ready);
		// Report each delivered SIGTERM so the test can send a repeat only after the first arrived; two back-to-back
		// kill() calls can merge into one pending signal.
		if (scenario.startsWith("external-repeat")) process.on("SIGTERM", () => record("sigterm"));
		record("mode-ready");
		if (scenario === "delay-callback") {
			record("main-block-start");
			const end = now() + 1800;
			while (now() < end) {
				/* delay main notification without delaying observer */
			}
			record("main-block-end");
		}
	}, 1);
}
process.on("exit", (code) => {
	clearInterval(keepAlive);
	record("exit-callback", { code });
});
