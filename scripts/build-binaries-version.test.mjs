import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bunTarget } from "./lib/bun-targets.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Build-test fixtures only: stage placeholder native resources, never runtime/provenance evidence. */
function stubNativeBuilders(agent) {
  mkdirSync(join(agent, "scripts"), { recursive: true });
  writeFileSync(join(agent, "scripts/build-process-owner.mjs"), `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(process.argv[2], { recursive: true });
writeFileSync(process.argv[2] + "/pi-env", process.env.CARGO_BUILD_TARGET ?? "");
`);
  const scripts = join(agent, "../../scripts");
  writeFileSync(join(scripts, "acquire-procward.mjs"), `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(process.argv[4], { recursive: true });
writeFileSync(process.argv[4] + "/procward", "build fixture");
`);
  writeFileSync(join(scripts, "build-procward-transport.mjs"), `import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
mkdirSync(dirname(process.argv[2]), { recursive: true });
writeFileSync(process.argv[2], "build fixture");
`);
}

test("binary builds accept a different Bun version and propagate compiler errors", { skip: process.platform === "win32" }, () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-bun-version-"));
  try {
    mkdirSync(join(temporary, "scripts/lib"), { recursive: true });
    cpSync(join(root, "scripts/build-binaries.sh"), join(temporary, "scripts/build-binaries.sh"));
    cpSync(join(root, "scripts/lib/bun-targets.mjs"), join(temporary, "scripts/lib/bun-targets.mjs"));
    const agent = join(temporary, "packages/coding-agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "package.json"), "{}");
    stubNativeBuilders(agent);
    const bun = join(temporary, "bun");
    writeFileSync(bun, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9"); process.exit(0); }
console.error("bun build: simulated compiler failure");
process.exit(3);
`);
    chmodSync(bun, 0o755);
    const output = join(temporary, "output");
    const result = spawnSync("bash", ["scripts/build-binaries.sh", "--skip-install", "--skip-build", "--platform", "linux-x64-gnu-modern", "--without-x11", "--out", output], {
      cwd: temporary,
      env: { ...process.env, PATH: `${temporary}${delimiter}${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /simulated compiler failure/);
    assert.doesNotMatch(result.stderr, /Bun compiler version mismatch/);
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
    stubNativeBuilders(agent);
    const bun = join(temporary, "bun");
    writeFileSync(bun, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9"); process.exit(0); }
const native = args.find(arg => arg.startsWith("--asset=") && arg.endsWith("/native"));
const files = native ? fs.readdirSync(native.slice(8), { recursive: true }).filter(file => file.endsWith(".node")) : [];
fs.writeFileSync(args[args.indexOf("--outfile") + 1], JSON.stringify(files.map(file => path.basename(file))));
`);
    chmodSync(bun, 0o755);
    // The FreeBSD owner NEEDED guard reads the stub helper; report a portable libc-only link.
    const readelf = join(temporary, "readelf");
    writeFileSync(readelf, "#!/bin/sh\necho ' 0x0000000000000001 (NEEDED)             Shared library: [libc.so.7]'\n");
    chmodSync(readelf, 0o755);
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
