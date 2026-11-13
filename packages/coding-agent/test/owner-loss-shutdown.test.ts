import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// Only synthetic lifecycle peers and this process's fixture children run on the host.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const launch = "a".repeat(32);
let directory: string;
let fixture: string;
interface TimelineEvent {
	event: string;
	at: number;
	delay?: number;
	observationOrigin?: number;
	enabled?: boolean;
	pending?: boolean;
}
interface Receipt {
	scenario: string;
	runtime: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	parentGuard: boolean;
	stderr: string;
	timeline: TimelineEvent[];
}

beforeAll(async () => {
	directory = mkdtempSync(join(root, ".owner-loss-fixture-"));
	fixture = join(directory, "hook.mjs");
	const workspace = new Map<string, string>();
	for (const name of readdirSync(join(root, "packages"))) {
		const path = join(root, "packages", name);
		const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { name: string };
		workspace.set(pkg.name, path);
	}
	await build({
		entryPoints: [fileURLToPath(new URL("./fixtures/owner-loss-shutdown.ts", import.meta.url))],
		outfile: fixture,
		platform: "node",
		format: "esm",
		bundle: true,
		ignoreAnnotations: true,
		plugins: [
			{
				name: "workspace-source-fixture",
				setup(builder) {
					builder.onResolve({ filter: /^@earendil-works\// }, ({ path }) => {
						const parts = path.split("/");
						const base = workspace.get(parts.slice(0, 2).join("/"));
						if (!base) return;
						const source = join(base, "src", parts.length === 2 ? "index" : parts.slice(2).join("/"));
						return { path: existsSync(`${source}.ts`) ? `${source}.ts` : join(source, "index.ts") };
					});
					builder.onResolve({ filter: /^[^./]/ }, async ({ path, importer, kind, pluginData }) => {
						if (pluginData === "resolved") return;
						// Resolve with import conditions at the original workspace, then keep deps external.
						const result = await builder.resolve(path, {
							resolveDir: dirname(importer || fixture),
							kind,
							pluginData: "resolved",
						});
						return { path: result.path, external: true, errors: result.errors };
					});
					// Keep asset paths relative to each original source, not the generated bundle.
					builder.onLoad({ filter: /\.ts$/ }, ({ path }) => ({
						contents: readFileSync(path, "utf8").replaceAll(
							"import.meta.url",
							JSON.stringify(new URL(`file://${path}`).href),
						),
						loader: "ts",
					}));
				},
			},
		],
	});
}, 30_000);

afterAll(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

async function run(scenario: string, runtime = process.execPath): Promise<Receipt> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_FIXTURE_DIRECTORY: directory,
		PI_OFFLINE: "1",
		PI_PROCWARD_BOOTSTRAP_NONCE: launch,
		PROCWARD_PROTOCOL: "1",
		PROCWARD_OWNER_PID: String(process.pid),
		PROCWARD_CONTRACT_ID: launch,
		PROCWARD_LIFECYCLE_FD: "3",
	};
	delete env.PI_NO_PROCESS_OWNERSHIP;
	const child = spawn(runtime, [fixture, scenario], {
		cwd: root,
		env,
		stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
	});
	const timeline: TimelineEvent[] = [];
	let stderr = "";
	let pending = "";
	let parentGuard = false;
	let sent = false;
	const loss = () => {
		if (sent) return;
		sent = true;
		timeline.push({ event: "peer-loss-sent", at: performance.timeOrigin + performance.now() });
		const lifecycle = child.stdio[3];
		if (!(lifecycle instanceof Duplex)) throw new Error("missing lifecycle transport");
		lifecycle.write(`PROCWARD/1 OWNER-LOSS ${launch}\n`);
		if (scenario === "repeated") {
			setTimeout(() => lifecycle.end(`PROCWARD/1 OWNER-LOSS ${launch}\n`), 1800).unref();
		}
	};
	child.stdout?.resume();
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const events = child.stdio[4];
	if (!events || !("on" in events)) throw new Error("missing event transport");
	let nativeSignalsSent = false;
	// A user or process manager repeats SIGTERM while the owner is alive and the hook hangs. Print mode can start its
	// hook before its signal handler is registered, so the repeat waits until the hook runs and the child reported the
	// first SIGTERM as delivered: two back-to-back kill() calls can merge into one pending signal.
	let externalTermDelivered = false;
	let hookStarted = false;
	let externalRepeatSent = false;
	const repeatExternalTerm = () => {
		if (!externalTermDelivered || !hookStarted || externalRepeatSent) return;
		externalRepeatSent = true;
		child.kill("SIGTERM");
	};
	events.on("data", (chunk: Buffer) => {
		pending += chunk.toString();
		let end = pending.indexOf("\n");
		while (end >= 0) {
			const event = JSON.parse(pending.slice(0, end)) as TimelineEvent;
			pending = pending.slice(end + 1);
			end = pending.indexOf("\n");
			timeline.push(event);
			if (event.event === "mode-ready") {
				if (scenario === "healthy") setTimeout(() => child.kill("SIGTERM"), 7800).unref();
				else if (scenario === "healthy-cont") {
					child.kill("SIGCONT");
					setTimeout(() => child.kill("SIGTERM"), 100).unref();
				} else if (scenario.startsWith("already-closing")) child.stdin?.end();
				else if (scenario.startsWith("external-repeat")) {
					child.kill("SIGTERM");
				} else if (scenario === "native-term-before-loss") {
					// The main thread can handle native TERMs before the worker publishes the loss.
					child.kill("SIGTERM");
					child.kill("SIGTERM");
					setTimeout(() => {
						loss();
						child.kill("SIGCONT");
					}, 50).unref();
				} else if (!scenario.startsWith("print-")) {
					loss();
					if (scenario === "native-term-cont") {
						child.kill("SIGTERM");
						child.kill("SIGCONT");
					}
					// Real procward can deliver TERM more than once while terminating its session.
					if (scenario === "native-term-repeat") {
						child.kill("SIGTERM");
						child.kill("SIGTERM");
						child.kill("SIGCONT");
					}
				}
			}
			// procward's documented order: Pi's bridge observes loss, then native sends TERM and CONT.
			if (event.event === "timer" && scenario === "native-term-after-loss" && !nativeSignalsSent) {
				nativeSignalsSent = true;
				child.kill("SIGTERM");
				child.kill("SIGCONT");
			}
			if (
				event.event === "hook-start" &&
				(scenario.startsWith("already-closing") || scenario.startsWith("print-"))
			) {
				setTimeout(loss, 150).unref();
			}
			if (event.event === "hook-start" && scenario.startsWith("external-repeat")) {
				hookStarted = true;
				repeatExternalTerm();
			}
			if (event.event === "sigterm" && scenario.startsWith("external-repeat")) {
				externalTermDelivered = true;
				repeatExternalTerm();
			}
			if (event.event === "message-held") {
				// Loss is already published in shared memory, but no JS loss callback ran.
				child.kill("SIGCONT");
			}
		}
	});
	const lifecycle = child.stdio[3];
	if (!(lifecycle instanceof Duplex)) throw new Error("missing lifecycle transport");
	lifecycle.on("error", () => {});
	lifecycle.write(`PROCWARD/1 READY ${process.pid} ${child.pid} parent ${launch}\n`);
	const guard = setTimeout(() => {
		parentGuard = true;
		child.kill("SIGKILL");
	}, 13_000);
	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolveExit({ code, signal }));
	});
	clearTimeout(guard);
	timeline.push({ event: "parent-exit", at: performance.timeOrigin + performance.now() });
	const receipt: Receipt = { scenario, runtime, ...result, parentGuard, stderr, timeline };
	console.log(JSON.stringify(receipt));
	expect(parentGuard, JSON.stringify(receipt)).toBe(false);
	expect(timeline.find((event) => event.event === "observer-ready")?.enabled, stderr).toBe(true);
	return receipt;
}

function assertBound(receipt: Receipt, budget: number): void {
	const sent = receipt.timeline.find((event) => event.event === "peer-loss-sent")!;
	const timer = receipt.timeline.find((event) => event.event === "timer" && event.observationOrigin! >= sent.at - 20);
	// Measure the child's own exit; a busy test runner can observe the close much later.
	// Only a SIGKILL exit has no exit callback, so it falls back to the runner's observation.
	const exited = receipt.timeline.find((event) => event.event === "exit-callback") ?? receipt.timeline.at(-1)!;
	const origin = timer?.observationOrigin ?? sent.at;
	// 350ms is measurement/scheduling allowance, not an extension of either product deadline.
	expect(exited.at - origin, JSON.stringify(receipt)).toBeGreaterThan(budget - 150);
	expect(exited.at - origin, JSON.stringify(receipt)).toBeLessThan(budget + 350);
}

describe.skipIf(process.platform === "win32")("production owner-loss bridge → mode SIGTERM → real runtime hook", () => {
	test.each([
		"pending-hook",
		"already-closing",
		"repeated",
		"delay-callback",
		"abort-wait",
		"credential-wait",
		"print-pending",
		"native-term-cont",
		"native-term-after-loss",
		"native-term-repeat",
		"native-term-before-loss",
	])(
		"bounds %s by first observation +5s",
		async (scenario) => {
			const receipt = await run(scenario);
			expect(receipt.code).toBe(143);
			expect(receipt.signal).toBeNull();
			expect(receipt.timeline.filter((event) => event.event === "hook-start")).toHaveLength(
				scenario === "abort-wait" ? 0 : 1,
			);
			assertBound(receipt, 5000);
			if (scenario.startsWith("native-term")) {
				const cont = receipt.timeline.find((event) => event.event === "cont-callback");
				expect(cont).toBeDefined();
				// Here TERM and CONT follow the loss after the worker has observed it.
				if (scenario === "native-term-after-loss") expect(cont?.pending).toBe(true);
				// Known residual: procward's TERM/CONT can reach Node before the worker reads the loss
				// it already published, and the UI may then resume briefly before the bounded exit.
				// Once shutdown is pending when CONT is handled, the UI never restarts.
				if (cont?.pending) {
					expect(
						receipt.timeline.filter((event) => event.event === "ui-start" || event.event === "ui-render"),
					).toHaveLength(0);
				}
			}
			if (scenario === "delay-callback") {
				const timer = receipt.timeline.find((event) => event.event === "timer");
				expect(timer?.delay).toBeLessThan(3500);
			}
		},
		16_000,
	);
	test.each(["cpu-hook", "already-closing-cpu"])(
		"the real %s is killed by the independent worker at +7s",
		async (scenario) => {
			const receipt = await run(scenario);
			expect(receipt.signal).toBe("SIGKILL");
			expect(receipt.timeline.filter((event) => event.event === "hook-start")).toHaveLength(1);
			assertBound(receipt, 7000);
		},
		16_000,
	);
	test.each(["external-repeat", "external-repeat-print"])(
		"a repeated external SIGTERM under a live owner still forces exit (%s)",
		async (scenario) => {
			const receipt = await run(scenario);
			expect(receipt.code).toBe(143);
			expect(receipt.stderr).not.toContain("owner gone");
			const ready = receipt.timeline.find((event) => event.event === "mode-ready")!;
			// The hook never yields; only the repeated signal can end the process.
			expect(receipt.timeline.find((event) => event.event === "hook-end")).toBeUndefined();
			expect(receipt.timeline.at(-1)!.at - ready.at).toBeLessThan(2000);
		},
		16_000,
	);
	test("healthy sessions have no owner-loss deadline; ordinary SIGTERM still exits normally", async () => {
		const receipt = await run("healthy");
		expect(receipt.code).toBe(143);
		expect(receipt.timeline.filter((event) => event.event === "hook-end")).toHaveLength(1);
		expect(receipt.stderr).not.toContain("owner gone");
	}, 16_000);
	test("loss before mode registration remains bounded", async () => {
		const receipt = await run("startup");
		expect(receipt.signal).toBe("SIGTERM");
		expect(receipt.timeline.filter((event) => event.event === "hook-start")).toHaveLength(0);
	});
	test("CONT before the main loss message never starts UI; healthy CONT still resumes", async () => {
		const loss = await run("cont-before-message");
		expect(loss.code).toBe(143);
		expect(loss.timeline.filter((event) => event.event === "ui-start" || event.event === "ui-render")).toHaveLength(
			0,
		);
		expect(loss.timeline.findIndex((event) => event.event === "cont-callback")).toBeLessThan(
			loss.timeline.findIndex((event) => event.event === "message-delivered"),
		);
		const healthy = await run("healthy-cont");
		expect(healthy.timeline.filter((event) => event.event === "ui-start")).toHaveLength(1);
		expect(healthy.timeline.filter((event) => event.event === "ui-render")).toHaveLength(1);
	});
	test
		.skipIf(!process.env.PI_OWNERLOSS_BUN)
		.each([
			"pending-hook",
			"cpu-hook",
			"delay-callback",
			"already-closing",
			"native-term-cont",
			"cont-before-message",
			"healthy-cont",
		])(
		"Bun controlled %s uses the default bridge and real runtime",
		async (scenario) => {
			const receipt = await run(scenario, resolve(process.env.PI_OWNERLOSS_BUN!));
			expect(receipt.timeline.filter((event) => event.event === "hook-start")).toHaveLength(1);
			if (scenario === "cpu-hook") {
				expect(receipt.signal).toBe("SIGKILL");
				assertBound(receipt, 7000);
			} else {
				expect(receipt.code).toBe(143);
				if (!["cont-before-message", "healthy-cont"].includes(scenario)) assertBound(receipt, 5000);
			}
			// native-term-cont has the same documented TERM/CONT-before-observation residual.
			const contPending = receipt.timeline.find((event) => event.event === "cont-callback")?.pending;
			if (
				scenario.includes("cont") &&
				scenario !== "healthy-cont" &&
				(scenario !== "native-term-cont" || contPending)
			) {
				expect(
					receipt.timeline.filter((event) => event.event === "ui-start" || event.event === "ui-render"),
				).toHaveLength(0);
			}
			if (scenario === "healthy-cont")
				expect(receipt.timeline.filter((event) => event.event === "ui-start")).toHaveLength(1);
		},
		16_000,
	);
});
