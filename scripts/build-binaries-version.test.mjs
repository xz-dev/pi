import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BUN_VERSION, bunTarget } from "./lib/bun-targets.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("binary builds reject a mismatched Bun before creating output", { skip: process.platform === "win32" }, () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-bun-version-"));
  try {
    const bun = join(temporary, "bun");
    writeFileSync(bun, '#!/bin/sh\nprintf "1.4.0\\n"\n');
    chmodSync(bun, 0o755);
    const output = join(temporary, "output");
    const result = spawnSync("bash", ["scripts/build-binaries.sh", "--skip-install", "--skip-build", "--platform", "linux-x64-gnu-modern", "--out", output], {
      cwd: root,
      env: { ...process.env, PATH: `${temporary}${delimiter}${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Bun compiler version mismatch: expected 1\.4\.2, got 1\.4\.0/);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("--without-x11 omits only X11 helpers and needs no musl helper directory", { skip: process.platform === "win32" }, () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-without-x11-"));
  try {
    mkdirSync(join(temporary, "scripts/lib"), { recursive: true });
    cpSync(join(root, "scripts/build-binaries.sh"), join(temporary, "scripts/build-binaries.sh"));
    cpSync(join(root, "scripts/lib/bun-targets.mjs"), join(temporary, "scripts/lib/bun-targets.mjs"));
    const agent = join(temporary, "packages/coding-agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "package.json"), "{}");
    const bun = join(temporary, "bun");
    writeFileSync(bun, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log(${JSON.stringify(BUN_VERSION)}); process.exit(0); }
const native = args.find(arg => arg.startsWith("--asset=") && arg.endsWith("/native"));
const files = native ? fs.readdirSync(native.slice(8), { recursive: true }).filter(file => file.endsWith(".node")) : [];
fs.writeFileSync(args[args.indexOf("--outfile") + 1], JSON.stringify(files.map(file => path.basename(file))));
`);
    chmodSync(bun, 0o755);
    for (const [target, withoutX11] of [
      ["linux-x64-gnu-baseline", false],
      ["linux-x64-gnu-baseline", true],
      ["linux-arm64-musl", true],
      ["freebsd-x64", true],
      ["darwin-arm64", true],
    ]) {
      const descriptor = bunTarget(target);
      const nativeDir = join(temporary, "packages/tui", descriptor.nativeHelperDir);
      mkdirSync(nativeDir, { recursive: true });
      writeFileSync(join(nativeDir, descriptor.nativeHelperFile), "native helper fixture");
      const output = join(temporary, "output");
      const args = ["scripts/build-binaries.sh", "--skip-install", "--skip-build", "--platform", target, "--out", output];
      if (withoutX11) args.push("--without-x11");
      const result = spawnSync("bash", args, {
        cwd: temporary,
        env: { ...process.env, PATH: `${temporary}${delimiter}${process.env.PATH}` },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `${target} withoutX11=${withoutX11}: ${result.stderr}`);
      const helpers = JSON.parse(readFileSync(join(output, `pi-${target}`), "utf8"));
      assert.deepEqual(helpers, withoutX11 && target !== "darwin-arm64" ? [] : [descriptor.nativeHelperFile]);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("version gate precedes dependency installation and compilation", () => {
  const script = readFileSync(join(root, "scripts/build-binaries.sh"), "utf8");
  assert.ok(script.indexOf("expected_bun=") < script.indexOf("npm ci --ignore-scripts"));
  assert.ok(script.indexOf("expected_bun=") < script.indexOf("bun build --compile"));
});
