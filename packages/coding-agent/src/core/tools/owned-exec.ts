/**
 * Owned tool execution: spawn tool commands under `procward run --control-fd`
 * so each task's tree is owned, cancellable, and observable.
 *
 * The control endpoint is a Unix-domain socketpair synthesized through an
 * abstract-namespace listener (Node exposes no socketpair API): the accepted
 * server-side fd is inherited by the child and passed to procward via
 * `--control-fd <n>` (its inherited fd number, which is 3 when stdio[3] is
 * the socket). Windows named-pipe task control is out of scope in this slice.
 *
 * Cancellation writes `PROCWARD/1 CANCEL\n` and reads until the contract's
 * C record plus EOF; a truncated or errored transcript settles the registry
 * entry as `unconfirmed` instead of success.
 */

import { spawn } from "node:child_process";
import { createServer, createConnection, type Socket } from "node:net";
import type { OwnedSession, OwnedTask } from "./process-registry.ts";

const CANCEL_REQUEST = "PROCWARD/1 CANCEL\n";
const CONTROL_FD = 3;

export interface OwnedExecOptions {
	/** Resolved vendored procward binary; undefined disables wrapping. */
	readonly procwardBinary: string | undefined;
	readonly registry: OwnedSession;
	/** Human-readable reason recorded with the task (which tool call). */
	readonly purpose: string;
}

export interface OwnedSpawn {
	/** argv for the owned spawn (procward run -- ...). */
	command: string;
	args: string[];
	/** stdio array with the control socket at index 3. */
	stdio: Array<"ignore" | "pipe" | "inherit" | Socket>;
	/** Register the live task once the wrapper process has a pid. */
	finalize(pid: number | undefined): OwnedTask | undefined;
	/** Cancel through the control endpoint; resolves with cleanup evidence. */
	cancel(): Promise<{ unconfirmed: boolean }>;
}

/**
 * Prepare an owned spawn for `command args`. Returns undefined when ownership
 * is unavailable (caller falls back to a direct spawn).
 */
export async function prepareOwnedSpawn(
	options: OwnedExecOptions,
	command: string,
	args: string[],
): Promise<OwnedSpawn | undefined> {
	if (process.platform === "win32") return undefined;
	const binary = options.procwardBinary;
	if (binary === undefined) return undefined;

	// Synthesize the socketpair: accept one connection on an abstract socket,
	// keep the client side for control traffic, hand the server side to the
	// child as its fd 3.
	const address = `\0pi-procward-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const server = createServer(() => {});
	await new Promise<void>((resolve) => server.listen(address, resolve));
	// Register the connection listener BEFORE connecting: the accepted socket
	// event must not race the connect.
	const peerPromise = new Promise<Socket>((resolve) => server.once("connection", resolve));
	const connector = createConnection(address);
	await new Promise<void>((resolve) => connector.once("connect", resolve));
	const peer = await peerPromise;
	connector.pause();
	server.close();

	const finalize = (pid: number | undefined): OwnedTask | undefined => {
		if (pid === undefined) {
			connector.destroy();
			peer.destroy();
			return undefined;
		}
		return options.registry.register({
			command: [command, ...args].join(" "),
			purpose: options.purpose,
			procwardPid: pid,
			cancel: () => {
				connector.write(CANCEL_REQUEST);
			},
		});
	};

	const cancel = (): Promise<{ unconfirmed: boolean }> => readControlCompletion(connector);

	return {
		command: binary,
		args: ["run", "--control-fd", String(CONTROL_FD), "--", command, ...args],
		stdio: ["ignore", "pipe", "pipe", peer],
		finalize,
		cancel,
	};
}

/** Read the task-control transcript until C+EOF; unconfirmed on truncation. */
async function readControlCompletion(client: Socket): Promise<{ unconfirmed: boolean }> {
	return await new Promise((resolve) => {
		let buffer = "";
		const complete = /^PROCWARD\/1 C (kernel|best-effort)\n$/m.test.bind(buffer);
		const finish = (unconfirmed: boolean) => {
			client.destroy();
			resolve({ unconfirmed });
		};
		const timer = setTimeout(() => finish(true), 15_000);
		const check = () => {
			if (buffer.includes("PROCWARD/1 E ")) {
				clearTimeout(timer);
				finish(true);
				return true;
			}
			return false;
		};
		client.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			if (check()) return;
			if (complete()) {
				// C seen; EOF must still follow for confirmed cleanup.
				client.once("close", () => {
					clearTimeout(timer);
					finish(false);
				});
			}
		});
		client.on("close", () => {
			clearTimeout(timer);
			finish(!complete());
		});
		client.resume();
	});
}
