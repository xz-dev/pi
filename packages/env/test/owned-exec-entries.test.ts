import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	Connection,
	type Json,
	RemoteError,
	type RemoteInfo,
	type Reply,
	type RequestOptions,
} from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const context = BACKGROUND_CONTEXT;
const info: RemoteInfo = {
	protocol: 1,
	version: "test",
	os: "linux",
	arch: "x86_64",
	home: "/home/test",
	tmpdir: "/tmp",
	separator: "/",
	cwd: "/",
	driveCwds: {},
	pid: 1,
	features: ["ownedExec1"],
};
const privateCode = "ERR_PROCESS_OWNER_CLEANUP";
function failure(state = "unconfirmed", code = "unknown"): RemoteError {
	return new RemoteError({
		code,
		message: "failure",
		owner: { v: 1, state },
		...(code === "unknown" ? { ownerError: { code: privateCode, message: "fence missing" } } : {}),
		spillPath: "/synthetic/spill",
	});
}
function fixture() {
	const connection = new Connection({ command: [] });
	vi.spyOn(connection, "info").mockResolvedValue(info);
	const kill = vi.spyOn(connection, "kill").mockImplementation(() => {});
	const calls: { json: Json; options: RequestOptions; done: ReturnType<typeof deferred<Reply>> }[] = [];
	const request = vi.spyOn(connection, "request").mockImplementation(async (_op, json, options = {}) => {
		const done = deferred<Reply>();
		calls.push({ json, options, done });
		options.onStart?.(calls.length, 1);
		return done.promise;
	});
	const env = new RemoteExecutionEnv({ connection, id: "synthetic", cwd: "/work" });
	return { connection, env, calls, request, kill };
}
function answer(call: ReturnType<typeof fixture>["calls"][number], exitCode = 7) {
	call.done.resolve({ json: { exitCode, owner: { v: 1, state: "complete" } }, session: 1, payload: new Uint8Array() });
}
async function tick() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => vi.stubEnv("PI_PROCESS_OWNER_BINARY", ""));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("owned exec entries", () => {
	it("captures host marker before cwd await, never from target env", async () => {
		const { env, connection, calls } = fixture();
		const gate = deferred<RemoteInfo>();
		vi.mocked(connection.info).mockReturnValueOnce(gate.promise);
		const running = env.exec(["job"], { cwd: ".", env: { PI_PROCESS_OWNER_BINARY: "/target-only" } }, context);
		delete process.env.PI_PROCESS_OWNER_BINARY;
		gate.resolve(info);
		await tick();
		expect(calls[0]!.json.owner).toEqual({ v: 1 });
		expect(calls[0]!.json.env).toEqual({ PI_PROCESS_OWNER_BINARY: "/target-only" });
		answer(calls[0]!);
		expect((await running).ok).toBe(true);
		const legacy = env.exec(["job"], { env: { PI_PROCESS_OWNER_BINARY: "/not-host" } }, context);
		await tick();
		expect(calls[1]!.json).not.toHaveProperty("owner");
		answer(calls[1]!);
		await legacy;
	});

	it("cleanup snapshots pre-cwd entries, joins concurrent cleanups, and prevents late dispatch", async () => {
		const { env, connection, calls } = fixture();
		const gate = deferred<RemoteInfo>();
		vi.mocked(connection.info).mockReturnValueOnce(gate.promise);
		const running = env.exec("job", { cwd: "." }, context);
		let joined = 0;
		const first = env.cleanup(context).then(() => joined++);
		const second = env.cleanup(context).then(() => joined++);
		await tick();
		expect(joined).toBe(0);
		gate.resolve(info);
		expect(await running).toMatchObject({ ok: false, error: { code: "aborted" } });
		await Promise.all([first, second]);
		expect(joined).toBe(2);
		expect(calls).toHaveLength(0);
		await env.cleanup(context);
	});

	it("cleanup during connection await aborts pending send and joins settlement", async () => {
		const { env, request, calls } = fixture();
		const ready = deferred<void>();
		request.mockImplementation(async (_op, _json, options = {}) => {
			await ready.promise;
			expect(options.signal?.aborted).toBe(true);
			throw new RemoteError({ code: "aborted", message: "aborted", owner: { v: 1, state: "not-started" } });
		});
		const running = env.exec(["job"], undefined, context);
		let joined = false;
		const cleanup = env.cleanup(context).then(() => {
			joined = true;
		});
		await tick();
		expect(joined).toBe(false);
		ready.resolve();
		expect(await running).toMatchObject({ ok: false, error: { code: "aborted" } });
		await cleanup;
		expect(calls).toHaveLength(0);
	});

	it("joins all snapshot entries, records uncertainty before done, and retains repeated rejection", async () => {
		const { env, calls, kill } = fixture();
		const first = env.exec(["one"], undefined, context);
		const second = env.exec(["two"], undefined, context);
		await tick();
		let settled = false;
		const cleanup = env.cleanup(context).catch((error: unknown) => {
			settled = true;
			return error;
		});
		expect(kill.mock.calls).toEqual([
			[1, 1],
			[2, 1],
		]);
		calls[0]!.done.reject(failure());
		expect(await first).toMatchObject({ ok: false, error: { code: "unknown", cause: { code: privateCode } } });
		await tick();
		expect(settled).toBe(false);
		answer(calls[1]!, 137);
		expect(await second).toMatchObject({ ok: true, value: { exitCode: 137 } });
		expect(await cleanup).toMatchObject({ code: "unknown", cause: { code: privateCode } });
		await expect(env.cleanup(context)).rejects.toMatchObject({ code: "unknown", cause: { code: privateCode } });
	});

	it.each(["none", "aborted", "timeout"])("uncertainty dominates callback and %s", async (mode) => {
		const { env, calls } = fixture();
		const abort = new AbortController();
		const callback = new Error("callback failed");
		const running = env.exec(
			"job",
			{
				onOutput: () => {
					throw callback;
				},
				timeout: mode === "timeout" ? 0.1 : 1,
			},
			withAbortSignal(abort.signal, context),
		);
		await tick();
		if (mode === "aborted") abort.abort();
		expect(calls[0]!.json.timeoutMs).toBe(mode === "timeout" ? 100 : 1000);
		calls[0]!.options.onEvent?.({ kind: "output" }, Buffer.from("output"));
		expect(calls[0]!.options.signal?.aborted).toBe(true);
		calls[0]!.done.reject(failure());
		expect(await running).toMatchObject({
			ok: false,
			error: { code: "unknown", cause: { code: privateCode }, spillPath: "/synthetic/spill" },
		});
		await expect(env.cleanup(context)).rejects.toMatchObject({ cause: { code: privateCode } });
	});

	it("confirmed callback failure keeps original cause and no retained uncertainty", async () => {
		const { env, calls } = fixture();
		const cause = new Error("callback failed");
		const running = env.exec(
			"job",
			{
				onOutput: () => {
					throw cause;
				},
			},
			context,
		);
		await tick();
		calls[0]!.options.onEvent?.({ kind: "output" }, Buffer.from("output"));
		calls[0]!.done.reject(failure("complete", "aborted"));
		const result = await running;
		expect(result).toMatchObject({ ok: false, error: { code: "callback_error", cause } });
		await env.cleanup(context);
	});

	it.each(["complete", "not-started"])("confirmed no-main abort remains aborted: %s", async (state) => {
		const { env, calls } = fixture();
		const running = env.exec("job", undefined, context);
		await tick();
		const cleanup = env.cleanup(context);
		calls[0]!.done.reject(failure(state, "aborted"));
		expect(await running).toMatchObject({ ok: false, error: { code: "aborted" } });
		await cleanup;
		await env.cleanup(context);
	});

	it.each(["cwd", "startup", "refused"])("no-dispatch %s failure never poisons cleanup", async (stage) => {
		const { env, connection, request, calls } = fixture();
		const error =
			stage === "refused" ? failure("not-started") : new RemoteError({ code: "spawn_error", message: "not sent" });
		if (stage === "cwd") vi.mocked(connection.info).mockRejectedValueOnce(error);
		else request.mockRejectedValueOnce(error);
		const result = await env.exec("job", { cwd: "." }, context);
		expect(result.ok).toBe(false);
		expect(calls).toHaveLength(0);
		await env.cleanup(context);
	});

	it("preserves ordinary RemoteError cause and confirmed fallback classification", async () => {
		const { env, calls } = fixture();
		const running = env.exec(["missing"], undefined, context);
		await tick();
		const cause = failure("not-started", "spawn_error");
		calls[0]!.done.reject(cause);
		const result = await running;
		expect(result).toMatchObject({ ok: false, error: { code: "spawn_error", cause } });
		await env.cleanup(context);
	});

	it("early validation, pre-abort, and cwd throw finish entries", async () => {
		const { env } = fixture();
		const abort = new AbortController();
		abort.abort();
		expect(await env.exec("job", undefined, withAbortSignal(abort.signal, context))).toMatchObject({
			ok: false,
			error: { code: "aborted" },
		});
		expect(await env.exec("job", { timeout: 0 }, context)).toMatchObject({ ok: false, error: { code: "timeout" } });
		await env.cleanup(context);
	});

	it("marker added after cwd await cannot promote a standalone operation", async () => {
		delete process.env.PI_PROCESS_OWNER_BINARY;
		const { env, connection, calls } = fixture();
		const gate = deferred<RemoteInfo>();
		vi.mocked(connection.info).mockReturnValueOnce(gate.promise);
		const running = env.exec(["job"], { cwd: "." }, context);
		process.env.PI_PROCESS_OWNER_BINARY = "/late";
		gate.resolve(info);
		await tick();
		expect(calls[0]!.json).not.toHaveProperty("owner");
		answer(calls[0]!);
		await running;
	});

	it("callback error on a confirmed RESULT keeps its spill path", async () => {
		const { env, calls } = fixture();
		const cause = new Error("callback failed");
		const running = env.exec(
			"job",
			{
				onOutput: () => {
					throw cause;
				},
			},
			context,
		);
		await tick();
		calls[0]!.options.onEvent?.({ kind: "output" }, Buffer.from("output"));
		calls[0]!.done.resolve({
			json: { exitCode: 7, spillPath: "/synthetic/spill", owner: { v: 1, state: "complete" } },
			session: 1,
			payload: new Uint8Array(),
		});
		expect(await running).toMatchObject({
			ok: false,
			error: { code: "callback_error", cause, spillPath: "/synthetic/spill" },
		});
		await env.cleanup(context);
	});

	it("abort during cwd resolution records local no-dispatch outcome", async () => {
		const { env, connection, calls } = fixture();
		const gate = deferred<RemoteInfo>();
		vi.mocked(connection.info).mockReturnValueOnce(gate.promise);
		const abort = new AbortController();
		const running = env.exec("job", { cwd: "." }, withAbortSignal(abort.signal, context));
		abort.abort();
		gate.resolve(info);
		expect(await running).toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(calls).toHaveLength(0);
		await env.cleanup(context);
	});

	it.each([false, true])(
		"isolates kill faults and joins concurrent cleanup with prior uncertainty: %s",
		async (prior) => {
			const { env, calls, kill } = fixture();
			let priorFailure: unknown;
			if (prior) {
				const earlier = env.exec(["earlier"], undefined, context);
				await tick();
				calls[0]!.done.reject(failure());
				const result = await earlier;
				if (!result.ok) priorFailure = result.error;
			}
			const first = env.exec(["one"], undefined, context);
			const second = env.exec(["two"], undefined, context);
			await tick();
			const firstCall = calls.at(-2)!;
			const secondCall = calls.at(-1)!;
			const firstWriteError = new Error("first kill failed");
			kill
				.mockImplementationOnce(() => {
					throw firstWriteError;
				})
				.mockImplementationOnce(() => {
					throw new Error("second kill failed");
				});
			let settled = 0;
			const clean = () =>
				env.cleanup(context).then(
					() => {
						settled++;
						return undefined;
					},
					(error: unknown) => {
						settled++;
						return error;
					},
				);
			const cleanup = clean();
			const concurrent = clean();
			const sends = kill.mock.calls.length;
			await tick();
			const settledBeforeAny = settled;
			firstCall.done.reject(failure());
			await first;
			await tick();
			const settledBeforeLast = settled;
			answer(secondCall, 7);
			expect(await second).toMatchObject({ ok: true, value: { exitCode: 7 } });
			const errors = await Promise.all([cleanup, concurrent]);
			expect(sends).toBe(4);
			expect(settledBeforeAny).toBe(0);
			expect(settledBeforeLast).toBe(0);
			expect(errors[0]).toMatchObject({ code: "unknown", cause: { code: privateCode } });
			if (prior) expect(errors[0]).toBe(priorFailure);
			else expect(errors[0]).toMatchObject({ cause: { cause: firstWriteError } });
			expect(errors[1]).toBe(errors[0]);
			await expect(env.cleanup(context)).rejects.toBe(errors[0]);
		},
	);

	it("legacy send failure cannot skip joining an owned snapshot entry", async () => {
		const { env, calls, kill } = fixture();
		const owned = env.exec(["owned"], undefined, context);
		delete process.env.PI_PROCESS_OWNER_BINARY;
		const legacy = env.exec(["legacy"], undefined, context);
		await tick();
		const writeError = new Error("legacy kill failed");
		kill.mockImplementation((id) => {
			if (id === 2) throw writeError;
		});
		let settled = false;
		const cleanup = env.cleanup(context).catch((error: unknown) => {
			settled = true;
			return error;
		});
		await tick();
		const settledBeforeOwned = settled;
		answer(calls[0]!, 7);
		expect(await owned).toMatchObject({ ok: true, value: { exitCode: 7 } });
		const error = await cleanup;
		const repeated = await env.cleanup(context).catch((error: unknown) => error);
		const sends = kill.mock.calls.length;
		answer(calls[1]!, 137);
		await legacy;
		expect(settledBeforeOwned).toBe(false);
		expect(error).toMatchObject({ code: "unknown", cause: { code: privateCode, cause: writeError } });
		expect(sends).toBe(3);
		expect(repeated).toBe(error);
		await expect(env.cleanup(context)).rejects.toBe(error);
	});

	it("legacy-only cleanup keeps raw send failure and immediate retry semantics", async () => {
		delete process.env.PI_PROCESS_OWNER_BINARY;
		const { env, calls, kill } = fixture();
		const running = env.exec(["legacy"], undefined, context);
		await tick();
		const writeError = new Error("legacy kill failed");
		kill.mockImplementationOnce(() => {
			throw writeError;
		});
		await expect(env.cleanup(context)).rejects.toBe(writeError);
		await env.cleanup(context);
		expect(kill).toHaveBeenCalledTimes(2);
		answer(calls[0]!, 137);
		await running;
		await env.cleanup(context);
	});

	it("legacy cleanup stays immediate and does not join daemon settlement", async () => {
		delete process.env.PI_PROCESS_OWNER_BINARY;
		const { env, calls, kill } = fixture();
		const running = env.exec("job", undefined, context);
		await tick();
		await env.cleanup(context);
		expect(kill).toHaveBeenCalledWith(1, 1);
		answer(calls[0]!, 137);
		await running;
	});
});
