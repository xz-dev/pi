// Runs inside an owned procward task: ordinary Node/Bun fork IPC must keep working.
import { fork } from "node:child_process";
import { createConnection, createServer } from "node:net";

if (process.argv[2] === "child") {
	process.on("message", (message, handle) => {
		if (message?.kind === "server") {
			handle.on("connection", (socket) => socket.end("handle-round-trip"));
			process.send({ kind: "handle-ready" });
		} else if (message?.kind === "echo") process.send({ kind: "echo", value: message.value });
	});
	process.on("disconnect", () => process.exit(0));
} else {
	const fail = (detail) => {
		console.error(detail);
		process.exit(97);
	};
	// Shorter than the gate's 10s owner bound so a runtime without handle passing fails deterministically.
	setTimeout(() => fail("fork IPC deadline"), 4000).unref();
	const child = fork(process.argv[1], ["child"], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
	child.on("error", (error) => fail(String(error)));
	const next = (kind) =>
		new Promise((resolve) => child.on("message", (message) => message.kind === kind && resolve(message)));
	const echoed = next("echo");
	child.send({ kind: "echo", value: "世界" });
	if ((await echoed).value !== "世界") fail("message round trip changed its value");
	const server = createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	const ready = next("handle-ready");
	await new Promise((resolve, reject) =>
		child.send({ kind: "server" }, server, (error) => (error ? reject(error) : resolve())),
	);
	await ready;
	await new Promise((resolve) => server.close(resolve));
	const response = await new Promise((resolve, reject) => {
		let text = "";
		const socket = createConnection(port, "127.0.0.1");
		socket.on("error", reject);
		socket.on("data", (data) => {
			text += data;
		});
		socket.on("end", () => resolve(text));
	});
	if (response !== "handle-round-trip") fail(`handle transfer answered ${JSON.stringify(response)}`);
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.disconnect();
	if ((await exited) !== 0) fail("forked child did not exit cleanly after disconnect");
	process.stdout.write("ipc-ok");
	process.exit(7);
}
