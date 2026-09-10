#!/usr/bin/env node
// Linux installed-tree acceptance. The controller may use Node/Bun; Pi children
// receive an isolated HOME and PATH with no external JavaScript runtime.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, watchFile, unwatchFile, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const [entryArg, receiptArg] = process.argv.slice(2);
assert.equal(process.platform, "linux", "this acceptance gate covers Linux only");
assert.ok(entryArg && receiptArg, "Usage: e2e-embedded-package-manager.mjs <public-pi> <fresh-receipt-dir>");
const entry = realpathSync(entryArg);
const root = resolve(receiptArg);
assert.ok(!existsSync(root), "receipt directory must be fresh");
mkdirSync(root, { recursive: true });
for (const folder of ["bin", "home", "agent", "work", "cache"]) mkdirSync(join(root, folder));
const bin = join(root, "bin");
symlinkSync(entry, join(bin, "pi"));
for (const name of ["git", "sh", "bash", "dirname", "basename", "uname", "tr", "sed", "grep", "cat", "mkdir", "rm", "env"] ) {
  const found = spawnSync("which", [name], { encoding: "utf8" });
  assert.equal(found.status, 0, `required system command: ${name}`);
  symlinkSync(found.stdout.trim(), join(bin, name));
}
const env = {
  HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"), PATH: bin,
  XDG_CACHE_HOME: join(root, "cache"), BUN_INSTALL_CACHE_DIR: join(root, "cache", "bun"),
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", JITI_FS_CACHE: "false", TERM: "dumb",
};
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const native = join(dirname(entry), "pi-native");
const receipt = {
  complete: false, entry, entrySha256: hash(entry),
  nativeSha256: existsSync(native) ? hash(native) : null,
  packageSha256: hash(join(dirname(entry), "package.json")),
  platform: process.platform, architecture: process.arch, checks: [],
};
function save() { writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"); }
save();
async function run(label, args, options = {}) {
  const child = spawn(join(bin, "pi"), args, { cwd: join(root, "work"), env: { ...env, ...options.env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout ?? 120000);
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  if (options.input) child.stdin.write(options.input);
  let stopWatching = () => {};
  if (options.untilFile) {
    const check = () => {
      if (existsSync(options.untilFile)) {
        stopWatching();
        child.stdin.end();
      }
    };
    stopWatching = () => unwatchFile(options.untilFile, check);
    watchFile(options.untilFile, { interval: 25 }, check);
    check();
  } else child.stdin.end();
  const code = await new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  }).finally(() => { clearTimeout(timer); stopWatching(); });
  writeFileSync(join(root, `${label}.stdout.log`), stdout);
  writeFileSync(join(root, `${label}.stderr.log`), stderr);
  receipt.checks.push({ label, code }); save();
  assert.equal(code, options.code ?? 0, `${label}: ${stderr}`);
  return stdout;
}
async function verifyNoDowngrade() {
  const name = "pi-acceptance-version-fixture";
  const tarballs = {};
  for (const version of ["1.0.0", "1.1.0", "2.0.0"]) {
    const directory = join(root, "registry", version);
    mkdirSync(join(directory, "package"), { recursive: true });
    writeFileSync(join(directory, "package", "package.json"), JSON.stringify({ name, version, pi: { extensions: ["./index.ts"] } }));
    writeFileSync(join(directory, "package", "index.ts"), "export default function () {}\n");
    const archive = join(directory, "package.tgz");
    const tar = spawnSync("tar", ["-czf", archive, "-C", directory, "package"], { encoding: "utf8" });
    assert.equal(tar.status, 0, tar.stderr);
    tarballs[version] = readFileSync(archive);
  }
  let latest = "2.0.0";
  let base;
  const server = createServer((request, response) => {
    if (request.url === `/${name}`) {
      response.setHeader("Content-Type", "application/json");
      const versions = Object.fromEntries(Object.keys(tarballs).map(version => [version, {
        name, version, pi: { extensions: ["./index.ts"] },
        dist: { tarball: `${base}/${version}.tgz`, shasum: createHash("sha1").update(tarballs[version]).digest("hex") },
      }]));
      response.end(JSON.stringify({ name, "dist-tags": { latest }, versions }));
    } else {
      const version = request.url?.slice(1).replace(/\.tgz$/, "");
      if (tarballs[version]) response.end(tarballs[version]);
      else { response.writeHead(404); response.end("{}"); }
    }
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  base = `http://127.0.0.1:${server.address().port}`;
  const registryEnv = { npm_config_registry: base };
  try {
    await run("version-fixture-install", ["install", `npm:${name}`], { env: { ...registryEnv, BUN_INSTALL_CACHE_DIR: join(root, "version-install-cache") } });
    const manifest = join(env.PI_CODING_AGENT_DIR, "npm", "node_modules", name, "package.json");
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).version, "2.0.0");
    const before = hash(manifest);
    const settingsBefore = hash(join(env.PI_CODING_AGENT_DIR, "settings.json"));
    latest = "1.0.0";
    for (const mode of ["bulk", "explicit"]) {
      const args = mode === "bulk" ? ["update", "--extensions"] : ["update", `npm:${name}`];
      await run(`no-downgrade-${mode}`, args, { code: 1, env: { ...registryEnv, BUN_INSTALL_CACHE_DIR: join(root, `empty-${mode}-cache`) } });
      assert.match(readFileSync(join(root, `no-downgrade-${mode}.stderr.log`), "utf8"), /Cannot verify update/);
      assert.equal(hash(manifest), before);
      assert.equal(hash(join(env.PI_CODING_AGENT_DIR, "settings.json")), settingsBefore);
      assert.equal(existsSync(join(root, "work", "package.json")), false);
    }
    await run("remove-version-fixture", ["remove", `npm:${name}`], { env: registryEnv });
    writeFileSync(join(root, "work", "package.json"), "{}\n");
    await run("range-fixture-install", ["install", `npm:${name}@^1.0.0`], { env: { ...registryEnv, BUN_INSTALL_CACHE_DIR: join(root, "range-install-cache") } });
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).version, "1.0.0");
    latest = "2.0.0";
    await run("range-fixture-update", ["update", `npm:${name}`], { env: { ...registryEnv, BUN_INSTALL_CACHE_DIR: join(root, "range-update-cache") } });
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).version, "1.1.0");
    assert.ok(JSON.parse(readFileSync(join(env.PI_CODING_AGENT_DIR, "settings.json"), "utf8")).packages.includes(`npm:${name}@^1.0.0`));
    await run("remove-range-fixture", ["remove", `npm:${name}@^1.0.0`], { env: registryEnv });
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
  }
}

const pins = [
  ["pi-notify", "2d69229acd3037c31d4e9d566d02f6c0b92f24b9"],
  ["pi-subagents", "88639462aae9ba97465b203a305f3abf66bd195c"],
];
const installed = name => join(env.PI_CODING_AGENT_DIR, "git", "github.com", "xz-dev", name);
const source = (name, pin) => `git:github.com/xz-dev/${name}@${pin}`;
try {
  receipt.version = (await run("version", ["--version"])).trim();
  receipt.bunVersion = (await run("bun-version", ["--version"], { env: { BUN_BE_BUN: "1" } })).trim();
  assert.equal(receipt.bunVersion, "1.4.2");
  receipt.plugins = [];
  for (const [name, pin] of pins) {
    await run(`install-${name}`, ["install", source(name, pin)]);
    const cwd = installed(name);
    const git = args => {
      const result = spawnSync(join(bin, "git"), args, { cwd, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    assert.equal(git(["rev-parse", "HEAD"]), pin);
    assert.equal(git(["remote", "get-url", "origin"]), `https://github.com/xz-dev/${name}`);
    assert.equal(git(["diff", "--", "package.json", "package-lock.json"]), "");
    receipt.plugins.push({ name, pin, origin: git(["remote", "get-url", "origin"]), manifestSha256: hash(join(cwd, "package.json")) });
  }
  assert.ok(existsSync(join(installed("pi-notify"), "node_modules/pi-extension-utils/dist/semantic-hook.js")));
  const settings = () => JSON.parse(readFileSync(join(env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"));
  assert.deepEqual(settings().packages, pins.map(([name, pin]) => source(name, pin)));
  const loadArgs = ["--mode", "rpc", "--no-session", "--no-skills", "--no-prompt-templates"];
  const rpc = await run("coexistence-rpc", loadArgs, { env: { PI_OFFLINE: "1" }, input: '{"id":"load","type":"get_state"}\n' });
  assert.ok(rpc.split("\n").some(line => { try { const value = JSON.parse(line); return value.id === "load" && value.success; } catch { return false; } }));
  const marker = join(root, "notify-action.txt");
  writeFileSync(join(env.PI_CODING_AGENT_DIR, "pi-notify.json"), JSON.stringify({
    events: { agent_settled: { actions: [] }, "tool_execution_start:ask_user_question": { actions: [] } },
    hooks: { "acceptance-notify": { actions: [["shell:/bin/sh", "-c", 'printf "notification verified\\n" > "$1"', "acceptance", marker]] } },
  }));
  const producer = join(root, "notify-producer.ts");
  writeFileSync(producer, `export default function(pi) {
    pi.registerCommand("acceptance-notify", { description: "Acceptance hook", handler: async () => {
      pi.events.emit("pi:semantic-hook:v1", { version: 1, name: "acceptance-notify" });
    }});
  }\n`);
  await run("notification-action", [...loadArgs, "--extension", producer], {
    env: { PI_OFFLINE: "1" },
    input: '{"id":"notify","type":"prompt","message":"/acceptance-notify"}\n',
    untilFile: marker,
  });
  assert.equal(readFileSync(marker, "utf8"), "notification verified\n");
  const provider = join(root, "provider.ts");
  const parent = join(root, "parent.ts");
  writeFileSync(provider, readFileSync(new URL("./fixtures/embedded-package-provider.ts", import.meta.url)));
  writeFileSync(parent, readFileSync(new URL("./fixtures/embedded-package-parent.ts", import.meta.url)));
  writeFileSync(join(root, "random-fixture.txt"), randomBytes(24).toString("hex"));
  const agents = join(root, "work", ".pi", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "fixture-reader.md"), `---\nname: fixture-reader\ndescription: Installed native read acceptance\nmodel: package-acceptance/local\ntools: read\nextensions:\n  - ${provider}\ncompletionGuard: false\n---\nRead the requested fixture.\n`);
  const nativeOutput = await run("native-child", [...loadArgs, "--no-extensions", "--extension", provider, "--extension", parent], {
    env: { PI_OFFLINE: "1", PI_PACKAGE_ACCEPTANCE_ROOT: root },
  });
  assert.match(nativeOutput, /PASS real native child read, notification, shutdown and observed exit/);
  assert.equal(JSON.parse(readFileSync(join(root, "native-terminal.json"), "utf8")).state, "observed");
  await run("update-real-plugins", ["update", "--extensions"]);
  const reload = await run("post-update-rpc", loadArgs, { env: { PI_OFFLINE: "1" }, input: '{"id":"load","type":"get_state"}\n' });
  assert.match(reload, /"success":true/);
  for (const [name, pin] of pins) {
    await run(`remove-${name}`, ["remove", source(name, pin)]);
    assert.ok(!settings().packages.includes(source(name, pin)));
  }
  await verifyNoDowngrade();
  assert.equal(hash(entry), receipt.entrySha256, "candidate changed during acceptance");
  if (receipt.nativeSha256) assert.equal(hash(native), receipt.nativeSha256);
  receipt.complete = true; save();
  console.log(`PASS installed package lifecycle: ${basename(entry)}; ${root}`);
} catch (error) {
  receipt.error = String(error); save(); throw error;
}
