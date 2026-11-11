/** Per-task procward control. Native lifecycle tests run in procward's VM runner. */
import type { ChildProcess } from "node:child_process";
import { Duplex } from "node:stream";
import {
	assertSessionProcessesOpen,
	type OwnedCompletion,
	type OwnedSession,
	type OwnedTask,
	type OwnedTaskProvenance,
	trackSessionSpawn,
} from "../process-registry.ts";

export type { OwnedCompletion } from "../process-registry.ts";

const CANCEL_REQUEST = "PROCWARD/1 CANCEL\n";
const DRAIN_DEADLINE_MS = 15_000;

export interface OwnedExecOptions {
	readonly procwardBinary: string | undefined;
	readonly registry: OwnedSession;
	readonly purpose: string;
	readonly provenance?: OwnedTaskProvenance;
}

export interface OwnedSpawn {
	readonly command: string;
	readonly args: string[];
	readonly stdio: ["ignore" | "pipe", "pipe", "pipe", "pipe"];
	readonly ready: Promise<OwnedTask | undefined>;
	/** X reports the command result, independently of later C + EOF. */
	readonly primaryExit: Promise<number | undefined>;
	/** Attach the spawned child's duplex control endpoint at fd 3. */
	finalize(child: ChildProcess): void;
	readonly completion: Promise<OwnedCompletion>;
	cancel(): Promise<OwnedCompletion>;
}

export function prepareOwnedSpawn(options: OwnedExecOptions, command: string, args: string[]): OwnedSpawn | undefined {
	if (options.procwardBinary === undefined) return undefined;
	assertSessionProcessesOpen(options.registry);
	// Windows needs a native HANDLE adapter; do not claim it is already wired.
	if (process.platform === "win32") throw new Error("procward task HANDLE transport is not implemented");

	let control: Duplex | undefined;
	let task: OwnedTask | undefined;
	let record = "";
	let scope: OwnedCompletion["scope"];
	let exitCode: number | undefined;
	let completedRecord = false;
	let finished = false;
	let childClosed = false;
	let settled = false;
	let transcriptUnconfirmed = false;
	let cancellationRequested = false;
	let cancellationSent = false;
	let drainTimer: NodeJS.Timeout | undefined;
	let resolveCompletion: (value: OwnedCompletion) => void = () => {};
	const completion = new Promise<OwnedCompletion>((resolve) => {
		resolveCompletion = resolve;
	});
	let resolveReady: (value: OwnedTask | undefined) => void = () => {};
	const ready = new Promise<OwnedTask | undefined>((resolve) => {
		resolveReady = resolve;
	});
	let resolvePrimary: (value: number | undefined) => void = () => {};
	const primaryExit = new Promise<number | undefined>((resolve) => {
		resolvePrimary = resolve;
	});

	const settle = (expired = false) => {
		if (settled || !finished || (!childClosed && !expired)) return;
		settled = true;
		if (drainTimer) clearTimeout(drainTimer);
		const unconfirmed = transcriptUnconfirmed || !childClosed;
		if (task) options.registry.settle(task.id, { descendantsAlive: false, unconfirmed });
		resolveCompletion({ exitCode, scope, unconfirmed });
	};
	const finish = (unconfirmed: boolean) => {
		if (finished) return;
		finished = true;
		transcriptUnconfirmed = unconfirmed;
		resolveReady(task);
		resolvePrimary(exitCode);
		control?.destroy();
		boundDrain();
		settle();
	};
	const boundDrain = () => {
		drainTimer ??= setTimeout(() => {
			finish(true);
			settle(true);
		}, DRAIN_DEADLINE_MS);
	};
	const sendCancellation = () => {
		if (!control || cancellationSent || finished) return;
		cancellationSent = true;
		control.write(CANCEL_REQUEST, (error) => {
			if (error) finish(true);
		});
	};
	const cancel = () => {
		if (!finished) {
			cancellationRequested = true;
			if (task) task.status = "reaping";
			boundDrain();
			sendCancellation();
		}
		return completion;
	};

	const owned: OwnedSpawn = {
		command: options.procwardBinary,
		args: ["run", "--retain-descendants", "--control-fd", "3", "--", command, ...args],
		// libuv's Unix UV_CREATE_PIPE uses socketpair(SOCK_STREAM). Extra
		// stdio pipes are duplex; no listener, socket path or retained peer is
		// needed. See Node deps/uv/src/unix/process.c: uv__process_init_stdio.
		stdio: ["ignore", "pipe", "pipe", "pipe"],
		ready,
		primaryExit,
		completion,
		cancel,
		finalize(child) {
			child.once("error", () => finish(true));
			child.once("close", () => {
				childClosed = true;
				finish(true);
				settle();
			});
			const endpoint = child.stdio[3];
			if (!(endpoint instanceof Duplex) || child.pid === undefined) {
				finish(true);
				return;
			}
			control = endpoint;
			const accept = (line: string) => {
				if (completedRecord) return finish(true);
				const started = /^PROCWARD\/1 S ([1-9][0-9]*) (kernel|best-effort)$/.exec(line);
				if (started && scope === undefined && Number(started[1]) === child.pid) {
					scope = started[2] === "kernel" ? "kernel" : "best-effort";
					task = options.registry.register({
						command: [command, ...args].join(" "),
						purpose: options.purpose,
						provenance: options.provenance,
						procwardPid: child.pid!,
						cancel,
					});
					if (cancellationRequested) task.status = "reaping";
					resolveReady(task);
					return;
				}
				const primary = /^PROCWARD\/1 X (0|[1-9][0-9]*)$/.exec(line);
				if (primary && scope !== undefined && exitCode === undefined && Number(primary[1]) <= 0xffff_ffff) {
					exitCode = Number(primary[1]);
					if (task && !cancellationRequested) {
						options.registry.settle(task.id, { descendantsAlive: true, unconfirmed: false });
					}
					resolvePrimary(exitCode);
					return;
				}
				if (scope !== undefined && exitCode !== undefined && line === `PROCWARD/1 C ${scope}`) {
					completedRecord = true;
					boundDrain();
					return;
				}
				finish(true);
			};
			endpoint.on("data", (chunk: Buffer) => {
				for (const byte of chunk) {
					if (finished) return;
					if (byte === 10) {
						accept(record);
						record = "";
					} else if (byte < 32 || byte > 126 || record.length >= 255) {
						finish(true);
					} else {
						record += String.fromCharCode(byte);
					}
				}
			});
			endpoint.once("end", () => finish(!completedRecord || record.length !== 0));
			endpoint.once("close", () => finish(true));
			endpoint.once("error", () => finish(true));
			if (cancellationRequested) sendCancellation();
		},
	};
	trackSessionSpawn(options.registry, owned);
	return owned;
}
