import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("version gate precedes dependency installation and compilation", () => {
  const script = readFileSync(join(root, "scripts/build-binaries.sh"), "utf8");
  assert.ok(script.indexOf("expected_bun=") < script.indexOf("npm ci --ignore-scripts"));
  assert.ok(script.indexOf("expected_bun=") < script.indexOf("bun build --compile"));
});
