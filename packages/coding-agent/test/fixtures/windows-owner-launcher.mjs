import { spawn } from "node:child_process";
const [owner, encoded] = process.argv.slice(2);
const child = spawn(owner, JSON.parse(encoded), { stdio: ["ignore", "ignore", "inherit", "pipe"] });
child.stdio[3].on("data", (bytes) => process.stdout.write(bytes));
child.stdio[3].on("error", () => {});
child.on("error", () => process.exit(125));
child.on("close", (code) => process.exit(code ?? 125));
