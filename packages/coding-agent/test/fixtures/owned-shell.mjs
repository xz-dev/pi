// Finite primary and setsid descendant: failed containment cannot leave busy fixtures.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

setTimeout(() => process.exit(91), 12000);
process.on("SIGTERM", () => {});
const descendant = spawn(process.execPath, ["-e", `
  const {writeFileSync} = require("node:fs");
  process.on("SIGTERM",()=>{});
  writeFileSync(process.argv[1],String(process.pid));
  setTimeout(()=>process.exit(92),10000);
`, process.argv[2]], { detached: true, stdio: "ignore" });
descendant.unref();
const deadline = Date.now() + 2000;
while (!existsSync(process.argv[2])) {
  if (Date.now() >= deadline) process.exit(93);
  await delay(10);
}
process.stdout.write(`${descendant.pid}\n`);
if (process.argv[3] === "exit") process.exit(0);
