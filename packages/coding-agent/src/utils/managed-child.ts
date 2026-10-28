import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { getProcwardTransport } from "../config.ts";

const CONTRACT_ENV = [
	"PROCWARD_PROTOCOL",
	"PROCWARD_OWNER_PID",
	"PROCWARD_CONTRACT_ID",
	"PROCWARD_LIFECYCLE_FD",
	"PROCWARD_LIFECYCLE_HANDLE",
	"PROCWARD_PRIMARY_PID",
];
type Transport = (
	operation: "prepare" | "read" | "close" | "identity",
	endpoint: string,
	identity?: string,
) => string | null;
let managed = false;
let ownerLost = false;
let ownerFailed = false;
let startupComplete = false;
let lossHandler: (() => void) | undefined;
let lifecycleWorker: Worker | undefined;
let pendingDrain: Promise<void> | undefined;

export function hasLostCliProcessOwner(): boolean {
	return ownerLost;
}
export function cliProcessOwnerExitCode(): number {
	return ownerFailed ? 125 : 0;
}

/** Drain queued notice before a native TERM handler observes ownership state. */
export function drainCliProcessOwner(): Promise<void> {
	const worker = lifecycleWorker;
	if (!worker) return Promise.resolve();
	pendingDrain ??= new Promise<void>((resolve) => {
		const acknowledge = (message: { drained?: boolean }) => {
			if (!message.drained) return;
			worker.off("message", acknowledge);
			pendingDrain = undefined;
			resolve();
		};
		worker.on("message", acknowledge);
		worker.postMessage("drain");
	});
	return pendingDrain;
}

function fallbackShutdown(): void {
	if (lossHandler || !startupComplete) return;
	if (ownerFailed) process.exit(125);
	process.off("SIGTERM", startupTerm);
	process.kill(process.pid, "SIGTERM");
}
function startupTerm(): void {
	void drainCliProcessOwner().then(() => {
		if (lossHandler) return;
		// Only genuine owner loss is latched during startup. Ordinary TERM keeps default semantics.
		if (ownerLost) fallbackShutdown();
		else {
			process.off("SIGTERM", startupTerm);
			process.kill(process.pid, "SIGTERM");
		}
	});
}

/** Print/RPC have no interactive signal hook; release their startup-only notice guard. */
export function completeCliProcessOwnerStartup(): void {
	startupComplete = true;
	if (ownerLost) fallbackShutdown();
}

export function onCliProcessOwnerLoss(handler: () => void): () => void {
	lossHandler = handler;
	startupComplete = true;
	if (ownerLost) queueMicrotask(handler);
	return () => {
		if (lossHandler === handler) lossHandler = undefined;
	};
}

// Pi's existing 7s bound must survive a blocked main JS thread, not rely on parent-PID polling.
const WATCHDOG = `
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
const transport = createRequire(workerData.addon)(workerData.addon).transport;
const ready = new Int32Array(workerData.ready);
let pending = workerData.pending, lostAt;
const lose = (error) => {
    if (lostAt !== undefined) return;
    lostAt = performance.now();
    parentPort.postMessage({ loss: true, error });
    transport("close", workerData.endpoint);
};
const poll = () => {
    if (lostAt !== undefined) {
        if (performance.now() - lostAt >= 7000) process.kill(process.pid, "SIGKILL");
        return;
    }
    try {
        if (!pending.includes("\\n")) {
            const data = transport("read", workerData.endpoint);
            if (data === null) { lose(pending ? "truncated lifecycle record" : "lifecycle EOF after READY"); return; }
            pending += data;
        }
        if (pending.length > 256) { lose("oversized lifecycle record"); return; }
        if (!pending.includes("\\n")) return;
        if (pending !== "PROCWARD/1 OWNER-LOSS " + workerData.id + "\\n") { lose("invalid lifecycle notice"); return; }
        lose();
    } catch (error) { lose(error.message); }
};
setInterval(poll, 20);
parentPort.on("message", () => { poll(); parentPort.postMessage({ drained: true }); });
Atomics.store(ready, 0, 1);
Atomics.notify(ready, 0);
`;

/** Consume once, scrub metadata and remove inheritance before any CLI graph or task can load. */
export function consumeProcwardContract(): boolean {
	if (managed) return true;
	if (!CONTRACT_ENV.some((key) => process.env[key] !== undefined)) return false;
	const protocol = process.env.PROCWARD_PROTOCOL;
	const owner = process.env.PROCWARD_OWNER_PID;
	const id = process.env.PROCWARD_CONTRACT_ID;
	const endpoint =
		process.platform === "win32" ? process.env.PROCWARD_LIFECYCLE_HANDLE : process.env.PROCWARD_LIFECYCLE_FD;
	const wrongEndpoint =
		process.platform === "win32" ? process.env.PROCWARD_LIFECYCLE_FD : process.env.PROCWARD_LIFECYCLE_HANDLE;
	// Scrub even rejected claims; PRIMARY_PID is obsolete and never confers authority.
	for (const key of CONTRACT_ENV) delete process.env[key];
	if (
		protocol !== "1" ||
		!owner ||
		!/^[1-9]\d*$/.test(owner) ||
		!Number.isSafeInteger(Number(owner)) ||
		!id ||
		!/^[0-9a-f]{32}$/.test(id) ||
		!endpoint ||
		!/^\d+$/.test(endpoint) ||
		wrongEndpoint !== undefined
	)
		throw new Error("Invalid procward managed-child environment");
	const deadline = performance.now() + 2000;
	const addon = getProcwardTransport();
	const { transport } = createRequire(import.meta.url)(addon) as { transport: Transport };
	transport("prepare", endpoint);
	let workerStarted = false;
	try {
		let record = "";
		const wait = new Int32Array(new SharedArrayBuffer(4));
		while (!record.includes("\n")) {
			if (performance.now() >= deadline) throw new Error("Procward READY deadline exceeded");
			const data = transport("read", endpoint);
			if (data === null) throw new Error("Procward EOF before READY");
			record += data;
			if (!record.includes("\n") && record.length >= 256) throw new Error("Oversized procward READY");
			if (!data) Atomics.wait(wait, 0, 0, Math.min(5, Math.max(0, deadline - performance.now())));
		}
		const newline = record.indexOf("\n");
		const fields = record.slice(0, newline).split(" ");
		if (
			newline >= 256 ||
			fields.length !== 6 ||
			fields[0] !== "PROCWARD/1" ||
			fields[1] !== "READY" ||
			fields[2] !== owner ||
			fields[3] !== String(process.pid)
		)
			throw new Error("Procward READY identity mismatch");
		// Record has six fields, including the launch ID; no Number conversion for Windows FILETIME.
		if (
			fields[5] !== id ||
			(process.platform === "win32" ? !/^[0-9a-f]{16}$/.test(fields[4]) : fields[4] !== "parent")
		)
			throw new Error("Procward READY identity mismatch");
		transport("identity", owner, fields[4]);
		const ready = new Int32Array(new SharedArrayBuffer(4));
		const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WATCHDOG)}`), {
			execArgv: [],
			workerData: { addon, endpoint, id, pending: record.slice(newline + 1), ready: ready.buffer },
		});
		workerStarted = true;
		lifecycleWorker = worker;
		let exiting = false;
		process.once("exit", () => {
			exiting = true;
		});
		const fail = () => {
			if (!exiting) process.exit(125);
		};
		worker.on("error", fail);
		worker.on("exit", fail);
		worker.on("message", (message: { loss?: boolean; error?: string }) => {
			if (!message.loss || ownerLost) return;
			ownerLost = true;
			ownerFailed = message.error !== undefined;
			if (message.error) console.error(`Procward lifecycle failed: ${message.error}`);
			if (lossHandler) lossHandler();
			else fallbackShutdown();
		});
		worker.unref();
		Atomics.wait(ready, 0, 0, Math.max(0, deadline - performance.now()));
		if (Atomics.load(ready, 0) !== 1) {
			void worker.terminate();
			throw new Error("Procward watchdog failed readiness");
		}
		transport("identity", owner, fields[4]);
		process.on("SIGTERM", startupTerm);
		managed = true;
		return true;
	} catch (error) {
		if (!workerStarted) transport("close", endpoint);
		throw error;
	}
}
