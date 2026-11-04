/** Finite real-daemon RPC/transport calibration; native control faults live in env-owned-trace.py. */
import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

const [mode, ...command] = process.argv.slice(2);
const gate = mode === "transport-eof" ? command.shift() : undefined;
const [daemon, ...args] = command;
if (!["featureless", "missing-owner", "transport-eof"].includes(mode ?? "") || !daemon)
	throw new Error("Invalid calibration args");
const child = spawn(daemon, args, { stdio: ["pipe", "pipe", "pipe"] });
let dropping = false;
const watcher = gate
	? watch(dirname(gate), (_event, name) => {
			if (String(name) === basename(gate) && existsSync(gate) && !dropping) {
				dropping = true;
				process.stdin.unpipe(child.stdin);
				child.stdin.end();
			}
		})
	: undefined;
const guard = setTimeout(() => child.kill("SIGKILL"), 7000);
let pending = Buffer.alloc(0);
let synced = false;
child.stdout.on("data", (chunk: Buffer) => {
	if (dropping) return;
	pending = Buffer.concat([pending, chunk]);
	if (!synced) {
		const end = pending.indexOf(10);
		if (end === -1) return;
		process.stdout.write(pending.subarray(0, end + 1));
		pending = pending.subarray(end + 1);
		synced = true;
	}
	while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
		const size = 4 + pending.readUInt32BE(0);
		const frame = pending.subarray(0, size);
		pending = pending.subarray(size);
		const type = frame.readUInt8(4);
		const jsonSize = frame.readUInt32BE(9);
		const json = JSON.parse(frame.subarray(13, 13 + jsonSize).toString("utf8"));
		if (type === 2 && Array.isArray(json.features) && mode === "featureless") {
			json.features = json.features.filter((feature: string) => feature !== "ownedExec1");
		} else if ((type === 2 || type === 3) && json.owner && mode === "missing-owner") {
			delete json.owner;
		} else {
			process.stdout.write(frame);
			continue;
		}
		const body = Buffer.from(JSON.stringify(json));
		const header = Buffer.from(frame.subarray(0, 13));
		header.writeUInt32BE(9 + body.length + frame.length - 13 - jsonSize, 0);
		header.writeUInt32BE(body.length, 9);
		process.stdout.write(Buffer.concat([header, body, frame.subarray(13 + jsonSize)]));
	}
});
process.stdin.pipe(child.stdin);
child.stderr.pipe(process.stderr);
child.stdin.on("error", () => {});
child.once("error", (error) => {
	console.error(error);
	process.exitCode = 1;
});
child.once("close", (code) => {
	watcher?.close();
	clearTimeout(guard);
	process.stdin.destroy();
	process.exitCode = code ?? 1;
});
process.on("SIGTERM", () => {
	child.stdin.end();
	child.kill();
});
