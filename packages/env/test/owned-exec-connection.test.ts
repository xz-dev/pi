import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, isConnectionLost, type Json } from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

function frame(type: number, id: number, json: Json): Buffer {
	const body = Buffer.from(JSON.stringify(json));
	const header = Buffer.alloc(13);
	header.writeUInt32BE(9 + body.length, 0);
	header.writeUInt8(type, 4);
	header.writeUInt32BE(id, 5);
	header.writeUInt32BE(body.length, 9);
	return Buffer.concat([header, body]);
}

class Peer extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly writes: { type: number; id: number; json: Json }[] = [];
	readonly stdin = new Writable({
		write: (data: Buffer, _encoding, done) => {
			const type = data.readUInt8(4);
			const id = data.readUInt32BE(5);
			const json = JSON.parse(data.subarray(13, 13 + data.readUInt32BE(9)).toString()) as Json;
			this.writes.push({ type, id, json });
			if (json.op === "hello")
				queueMicrotask(() => {
					if (this.autoHello) this.reply(id, this.info);
				});
			done();
		},
	});
	info: Json = { protocol: 1, os: "linux", features: ["ownedExec1"] };
	autoHello = true;
	kill = vi.fn(() => true);
	reply(id: number, json: Json, type = 2): void {
		this.stdout.write(frame(type, id, json));
	}
}

let peers: Peer[];
let connections: Connection[];
beforeEach(() => {
	peers = [];
	connections = [];
	mocks.spawn.mockImplementation((_program: string, args: string[]) => {
		const peer = new Peer();
		peers.push(peer);
		queueMicrotask(() => peer.stdout.write(`PI-ENV ${args.at(-1)}\n`));
		return peer;
	});
});
afterEach(() => {
	for (const connection of connections) connection.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
function connection(): Connection {
	const result = new Connection({ command: ["synthetic-daemon"] });
	connections.push(result);
	return result;
}
async function ready(info: Json = {}): Promise<{ connection: Connection; peer: Peer; session: number }> {
	const current = connection();
	const starting = current.session();
	Object.assign(peers[0]!.info, info);
	const session = await starting;
	return { connection: current, peer: peers[0]!, session };
}
const owner = { v: 1 };
const complete = { owner: { v: 1, state: "complete" }, exitCode: 7 };
const privateError = { code: "ERR_PROCESS_OWNER_CLEANUP", message: "fence missing" };

describe("owned exec connection fault ordering", () => {
	it.each([{ features: undefined }, { features: [] }, { features: ["listFiles"] }, { features: "ownedExec1" }])(
		"refuses featureless or malformed session without dispatch: %j",
		async ({ features }) => {
			const { connection, peer } = await ready({ features });
			const result = connection.request("exec", { owner }).catch((error: unknown) => error);
			await Promise.resolve();
			expect(peer.writes.filter((write) => write.json.op === "exec")).toHaveLength(0);
			expect(await result).toMatchObject({ code: "unknown", cause: { code: privateError.code } });
		},
	);

	it("refuses non-Linux owned exec but leaves unmarked exec legacy", async () => {
		const { connection, peer } = await ready({ os: "windows" });
		const refused = connection.request("exec", { owner }).catch((error: unknown) => error);
		await Promise.resolve();
		expect(peer.writes).toHaveLength(1);
		expect(await refused).toMatchObject({ code: "unknown", cause: { code: privateError.code } });
		const legacy = connection.request("exec", {}, { session: 1 });
		peer.reply(peer.writes.at(-1)!.id, { exitCode: 125 });
		expect((await legacy).json.exitCode).toBe(125);
	});

	it("checks pinned session, never separate info() or a reconnected capability", async () => {
		const { connection, peer, session } = await ready();
		vi.spyOn(connection, "info").mockRejectedValue(new Error("must not be called"));
		peer.emit("exit", 1);
		await connection.info().catch(() => undefined);
		const pinned = connection.request("exec", { owner }, { session }).catch((error: unknown) => error);
		expect(await pinned).toMatchObject({ fields: { lost: true } });
		expect(peers).toHaveLength(1);
	});

	it("preflights replacement session, even when previous daemon advertised ownedExec1", async () => {
		const { connection, peer } = await ready();
		peer.emit("exit", 1);
		const reconnect = connection.session();
		peers[1]!.info.features = [];
		await reconnect;
		const result = connection.request("exec", { owner }).catch((error: unknown) => error);
		await Promise.resolve();
		expect(peers[1]!.writes).toHaveLength(1);
		expect(await result).toMatchObject({ cause: { code: privateError.code } });
	});

	it("writes REQUEST before onStart kill and racing-abort CANCEL", async () => {
		const { connection, peer, session } = await ready();
		const abort = new AbortController();
		const result = connection.request(
			"exec",
			{ owner },
			{
				session,
				signal: abort.signal,
				onStart: (id, current) => {
					connection.kill(id, current);
					abort.abort();
				},
			},
		);
		void result.catch(() => {});
		expect(peer.writes.slice(1).map((write) => [write.type, write.json.mode])).toEqual([
			[1, undefined],
			[5, "kill"],
			[5, undefined],
			[5, undefined],
		]);
		peer.reply(peer.writes[1]!.id, complete);
		await result;
	});

	it.each([{ features: ["ownedExec1"] }, { features: [] }])(
		"pre-aborted owned exec has no write and no uncertainty: %j",
		async ({ features }) => {
			const { connection, peer, session } = await ready({ features });
			const abort = new AbortController();
			abort.abort();
			const result = connection
				.request("exec", { owner }, { session, signal: abort.signal })
				.catch((error: unknown) => error);
			expect(peer.writes).toHaveLength(1);
			expect(await result).toMatchObject({
				code: "aborted",
				fields: { owner: { state: "not-started" } },
			});
		},
	);

	it("legacy pre-aborted exec preserves onStart-before-REQUEST and CANCEL ordering", async () => {
		const { connection, peer, session } = await ready({ features: [] });
		const abort = new AbortController();
		abort.abort();
		const result = connection.request(
			"exec",
			{},
			{ session, signal: abort.signal, onStart: (id, current) => connection.kill(id, current) },
		);
		expect(peer.writes.slice(1).map((write) => write.type)).toEqual([5, 1, 5]);
		peer.reply(peer.writes[2]!.id, { exitCode: 137 });
		expect((await result).json.exitCode).toBe(137);
	});

	it.each([
		{},
		{ owner: null },
		{ owner: { v: 2, state: "complete" } },
		{ owner: { v: 1, state: "bogus" } },
		{ owner: { v: 1, state: "complete", extra: true } },
		{ owner: { v: 1, state: "not-started" } },
		{ owner: { v: 1, state: "unconfirmed" } },
	])("rejects invalid RESULT metadata %j", async (terminal) => {
		const { connection, peer, session } = await ready();
		const result = connection.request("exec", { owner }, { session }).catch((error: unknown) => error);
		peer.reply(peer.writes.at(-1)!.id, { ...terminal, exitCode: 7 });
		expect(await result).toMatchObject({
			code: "unknown",
			fields: { owner: { state: "unconfirmed" } },
			cause: { code: privateError.code },
		});
		expect(isConnectionLost(await result)).toBe(false);
	});

	it.each([
		{ code: "spawn_error", owner: { v: 1, state: "unconfirmed" }, ownerError: privateError },
		{ code: "unknown", owner: { v: 1, state: "unconfirmed" } },
		{ code: "unknown", owner: { v: 1, state: "unconfirmed" }, ownerError: { code: "wrong", message: "bad" } },
		{ code: "aborted", owner: { v: 1, state: "complete" }, ownerError: privateError },
	])("rejects inconsistent ERROR metadata %j", async (terminal) => {
		const { connection, peer, session } = await ready();
		const result = connection.request("exec", { owner }, { session }).catch((error: unknown) => error);
		peer.reply(peer.writes.at(-1)!.id, terminal, 3);
		expect(await result).toMatchObject({
			code: "unknown",
			cause: { code: privateError.code },
			fields: { owner: { state: "unconfirmed" } },
		});
	});

	it.each(["complete", "not-started"])("keeps confirmed spawn_error safe for fallback: %s", async (state) => {
		const { connection, peer, session } = await ready();
		const result = connection.request("exec", { owner }, { session }).catch((error: unknown) => error);
		peer.reply(
			peer.writes.at(-1)!.id,
			{ code: "spawn_error", message: "ENOENT", owner: { v: 1, state }, spawn: { stage: "target", errno: 2 } },
			3,
		);
		expect(await result).toMatchObject({ code: "spawn_error", fields: { spawn: { errno: 2 } } });
	});

	it.each(["complete", "not-started"])(
		"preserves confirmed no-main aborted without fabricated status: %s",
		async (state) => {
			const { connection, peer, session } = await ready();
			const result = connection.request("exec", { owner }, { session }).catch((error: unknown) => error);
			peer.reply(peer.writes.at(-1)!.id, { code: "aborted", message: "aborted", owner: { v: 1, state } }, 3);
			expect(await result).toMatchObject({ code: "aborted" });
			expect(await result).not.toHaveProperty("cause");
		},
	);

	it("marks attempted write uncertain on transport loss; never replays", async () => {
		const { connection, peer, session } = await ready();
		const result = connection.request("exec", { owner }, { session }).catch((error: unknown) => error);
		peer.emit("exit", 1);
		expect(await result).toMatchObject({
			code: "unknown",
			cause: { code: privateError.code },
			fields: { lost: true, owner: { state: "unconfirmed" } },
		});
		expect(peers).toHaveLength(1);
	});

	it("treats synchronous REQUEST write throw as uncertain, not safe spawn failure", async () => {
		const { connection, peer, session } = await ready();
		vi.spyOn(peer.stdin, "write").mockImplementation(() => {
			throw new Error("write failed");
		});
		const result = await connection.request("exec", { owner }, { session }).catch((error: unknown) => error);
		expect(result).toMatchObject({ code: "unknown", cause: { code: privateError.code } });
	});

	it("cleanup during actual hello registers before await, joins, and prevents exec write", async () => {
		vi.stubEnv("PI_PROCESS_OWNER_BINARY", "/invalid-host-path-not-sent");
		const current = connection();
		const env = new RemoteExecutionEnv({ connection: current, id: "test", cwd: "/synthetic" });
		const running = env.exec(["job"], undefined, BACKGROUND_CONTEXT);
		const peer = peers[0]!;
		peer.autoHello = false;
		let joined = false;
		const cleanup = env.cleanup(BACKGROUND_CONTEXT).then(() => {
			joined = true;
		});
		await Promise.resolve();
		expect(joined).toBe(false);
		expect(peer.writes).toHaveLength(1);
		peer.reply(peer.writes[0]!.id, peer.info);
		expect(await running).toMatchObject({ ok: false, error: { code: "aborted" } });
		await cleanup;
		expect(peer.writes).toHaveLength(1);
		await env.cleanup(BACKGROUND_CONTEXT);
	});

	it("abort during REQUEST write still joins terminal settlement", async () => {
		const { connection, peer, session } = await ready();
		const abort = new AbortController();
		const write = peer.stdin.write.bind(peer.stdin);
		vi.spyOn(peer.stdin, "write").mockImplementationOnce((data: Uint8Array | string) => {
			const result = write(data);
			abort.abort();
			return result;
		});
		let settled = false;
		const result = connection.request("exec", { owner }, { session, signal: abort.signal }).then((reply) => {
			settled = true;
			return reply;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(peer.writes.slice(1).map((item) => item.type)).toEqual([1, 5, 5]);
		peer.reply(peer.writes[1]!.id, complete);
		expect((await result).json.exitCode).toBe(7);
	});

	it("pinned featureless session is refused locally even if info() claims capability", async () => {
		const { connection, peer, session } = await ready({ features: [] });
		vi.spyOn(connection, "info").mockResolvedValue({ protocol: 1, os: "linux", features: ["ownedExec1"] } as Awaited<
			ReturnType<Connection["info"]>
		>);
		const result = connection.request("exec", { owner }, { session }).catch((error: unknown) => error);
		expect(peer.writes).toHaveLength(1);
		expect(await result).toMatchObject({
			code: "unknown",
			fields: { owner: { state: "not-started" } },
		});
	});

	it("stdin error after attempted write is lost and unconfirmed", async () => {
		const { connection, peer, session } = await ready();
		const result = connection.request("exec", { owner }, { session }).catch((error: unknown) => error);
		let settled: unknown;
		void result.then((error) => {
			settled = error;
		});
		peer.stdin.emit("error", new Error("EPIPE"));
		for (let turn = 0; turn < 5; turn++) await Promise.resolve();
		expect(settled).toMatchObject({
			cause: { code: privateError.code },
			fields: { lost: true, owner: { state: "unconfirmed" } },
		});
	});

	it("serialization failure is proven no-write, not remote uncertainty", async () => {
		const { connection, peer, session } = await ready();
		const json: Json = { owner };
		json.cycle = json;
		const error = await connection.request("exec", json, { session }).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(TypeError);
		expect(error).not.toHaveProperty("cause");
		expect(peer.writes).toHaveLength(1);
	});

	it("valid unconfirmed terminal preserves spill and underlying cause without claiming lost", async () => {
		const { connection, peer, session } = await ready();
		const result = connection.request("exec", { owner }, { session }).catch((error: unknown) => error);
		peer.reply(
			peer.writes.at(-1)!.id,
			{
				code: "unknown",
				message: "uncertain",
				owner: { v: 1, state: "unconfirmed" },
				ownerError: privateError,
				spillPath: "/synthetic/spill",
				cause: { code: "EIO" },
			},
			3,
		);
		expect(await result).toMatchObject({
			cause: { code: privateError.code, cause: { code: "EIO" } },
			fields: { spillPath: "/synthetic/spill" },
		});
		expect(isConnectionLost(await result)).toBe(false);
	});

	it("stops and joins cwd-blocked entry after completed-entry kill write throws", async () => {
		vi.stubEnv("PI_PROCESS_OWNER_BINARY", "");
		const { connection, peer } = await ready();
		const env = new RemoteExecutionEnv({ connection, id: "cleanup-fault", cwd: "/synthetic" });
		const first = env.exec(["one"], undefined, BACKGROUND_CONTEXT);
		for (let turn = 0; turn < 8; turn++) await Promise.resolve();
		let open!: (info: Awaited<ReturnType<Connection["info"]>>) => void;
		const blocked = new Promise<Awaited<ReturnType<Connection["info"]>>>((resolve) => {
			open = resolve;
		});
		vi.spyOn(connection, "info").mockReturnValueOnce(blocked);
		const second = env.exec(["two"], { cwd: "." }, BACKGROUND_CONTEXT);
		peer.reply(peer.writes.at(-1)!.id, complete);
		const writeError = new Error("kill write failed");
		vi.spyOn(peer.stdin, "write").mockImplementationOnce(() => {
			throw writeError;
		});
		let settled = false;
		const cleanup = env.cleanup(BACKGROUND_CONTEXT).then(
			() => {
				settled = true;
				return undefined;
			},
			(error: unknown) => {
				settled = true;
				return error;
			},
		);
		const firstResult = await first;
		for (let turn = 0; turn < 8; turn++) await Promise.resolve();
		const settledBeforeCwd = settled;
		open(peer.info as unknown as Awaited<ReturnType<Connection["info"]>>);
		for (let turn = 0; turn < 8; turn++) await Promise.resolve();
		const requests = peer.writes.filter((item) => item.json.op === "exec");
		if (requests.length > 1) peer.reply(requests.at(-1)!.id, complete);
		const secondResult = await second;
		const cleanupError = await cleanup;
		console.log(JSON.stringify({ settledBeforeCwd, execRequests: requests.length, firstResult, secondResult }));
		expect(settledBeforeCwd).toBe(false);
		expect(requests).toHaveLength(1);
		expect(firstResult).toMatchObject({ ok: true, value: { exitCode: 7 } });
		expect(secondResult).toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(cleanupError).toMatchObject({ code: "unknown", cause: { code: privateError.code, cause: writeError } });
		await expect(env.cleanup(BACKGROUND_CONTEXT)).rejects.toBe(cleanupError);
	});

	it("retains real startup failure as no-dispatch spawn_error", async () => {
		const current = new Connection({
			command: async () => {
				throw new Error("startup failed");
			},
		});
		connections.push(current);
		const result = await current.request("exec", { owner }).catch((error: unknown) => error);
		expect(result).toMatchObject({ code: "spawn_error", message: "startup failed" });
		expect(result).not.toHaveProperty("cause");
		expect(peers).toHaveLength(0);
	});
});
