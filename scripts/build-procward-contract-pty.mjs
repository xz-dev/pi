#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bunTarget } from "./lib/bun-targets.mjs";

const [targetId, destination] = process.argv.slice(2);
const target = bunTarget(targetId);
if (target.os !== "linux" || target.libc !== "musl" || !destination) throw new Error("Usage: build-procward-contract-pty.mjs <musl Bun target> <output>");
const output = resolve(destination);
mkdirSync(dirname(output), { recursive: true });
execFileSync("zig", ["cc", "-target", target.cargoTarget.replace("-unknown-", "-"), "-static", "-std=c11", "-Os", "-Wall", "-Wextra", "-Werror", fileURLToPath(new URL("./fixtures/procward/pty-contract.c", import.meta.url)), "-o", output], { stdio: "inherit", timeout: 120000 });
console.log(`Built static PTY contract glue: ${output}`);
