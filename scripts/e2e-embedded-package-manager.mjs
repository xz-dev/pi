#!/usr/bin/env node
// Linux installed-tree acceptance. The controller may use Node/Bun; Pi children
// receive an isolated HOME and PATH with no external JavaScript runtime.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, watchFile, unwatchFile, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [entryArg, receiptArg, mode] = process.argv.slice(2);
assert.ok(mode === undefined || mode === "--dependencies-only", "unknown acceptance mode");
assert.equal(process.platform, "linux", "this acceptance gate covers Linux only");
assert.ok(entryArg && receiptArg, "Usage: e2e-embedded-package-manager.mjs <public-pi> <fresh-receipt-dir>");
const entry = realpathSync(entryArg);
const root = resolve(receiptArg);
assert.ok(!existsSync(root), "receipt directory must be fresh");
mkdirSync(root, { recursive: true });
for (const folder of ["bin", "home", "agent", "work", "cache", "tmp"]) mkdirSync(join(root, folder));
const bin = join(root, "bin");
symlinkSync(entry, join(bin, "pi"));
for (const name of ["git", "sh", "bash", "dirname", "basename", "uname", "tr", "sed", "grep", "cat", "mkdir", "rm", "env"] ) {
  const found = spawnSync("which", [name], { encoding: "utf8" });
  assert.equal(found.status, 0, `required system command: ${name}`);
  symlinkSync(found.stdout.trim(), join(bin, name));
}
const env = {
  HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"), PATH: bin, TMPDIR: join(root, "tmp"),
  XDG_CACHE_HOME: join(root, "cache"), BUN_INSTALL_CACHE_DIR: join(root, "cache", "bun"),
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", JITI_FS_CACHE: "false", TERM: "dumb",
};
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const receipt = {
  complete: false, entry, entrySha256: hash(entry),
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
    const settingsBefore = hash(join(env.PI_CODING_AGENT_DIR, "settings.json"));
    latest = "1.0.0";
    // The version check must succeed from a work dir without a package.json:
    // embedded Bun runs `info` inside the managed install root, so update is
    // skipped (installed 2.0.0 > registry latest 1.0.0) and no warning appears.
    for (const mode of ["bulk", "explicit"]) {
      const args = mode === "bulk" ? ["update", "--extensions"] : ["update", `npm:${name}`];
      await run(`unknown-version-${mode}`, args, { env: { ...registryEnv, BUN_INSTALL_CACHE_DIR: join(root, `empty-${mode}-cache`) } });
      const warning = readFileSync(join(root, `unknown-version-${mode}.stderr.log`), "utf8");
      assert.doesNotMatch(warning, /Cannot verify update/);
      assert.doesNotMatch(warning, /may be downgraded/);
      assert.equal(JSON.parse(readFileSync(manifest, "utf8")).version, "2.0.0");
      assert.equal(hash(join(env.PI_CODING_AGENT_DIR, "settings.json")), settingsBefore);
      assert.equal(existsSync(join(root, "work", "package.json")), false);
    }
    // The warn-and-continue path still needs coverage: when metadata lookup
    // fails outright (dead registry), the update is attempted anyway and
    // warns before the download itself fails against the dead registry (exit 1).
    const deadRegistryEnv = { npm_config_registry: "http://127.0.0.1:1" };
    for (const mode of ["bulk", "explicit"]) {
      const args = mode === "bulk" ? ["update", "--extensions"] : ["update", `npm:${name}`];
      await run(`unreachable-version-${mode}`, args, { env: { ...deadRegistryEnv, BUN_INSTALL_CACHE_DIR: join(root, `dead-${mode}-cache`) }, code: 1 });
      const warning = readFileSync(join(root, `unreachable-version-${mode}.stderr.log`), "utf8");
      assert.match(warning, /Cannot verify update/);
      assert.match(warning, /may be downgraded/);
      assert.equal(hash(join(env.PI_CODING_AGENT_DIR, "settings.json")), settingsBefore);
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
    await run("known-version-install", ["install", `npm:${name}`], { env: { ...registryEnv, BUN_INSTALL_CACHE_DIR: join(root, "known-install-cache") } });
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).version, "2.0.0");
    latest = "1.0.0";
    await run("known-version-no-downgrade", ["update", `npm:${name}`], { env: { ...registryEnv, BUN_INSTALL_CACHE_DIR: join(root, "known-update-cache") } });
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).version, "2.0.0");
    assert.doesNotMatch(readFileSync(join(root, "known-version-no-downgrade.stderr.log"), "utf8"), /may be downgraded/);
    await run("remove-known-version-fixture", ["remove", `npm:${name}`], { env: registryEnv });
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
  }
}

async function verifyFloatingDependencies() {
  const a = "pi-dependency-acceptance-a", b = "pi-dependency-acceptance-b", c = "pi-dependency-acceptance-c";
  const bridge = "pi-dependency-acceptance-bridge", leaf = "pi-dependency-acceptance-leaf", fixed = "pi-dependency-acceptance-fixed";
  const unselected = "pi-dependency-acceptance-unselected", sourceLeaf = "pi-dependency-acceptance-source-leaf";
  const sourceName = "pi-dependency-acceptance-git-source";
  const sourceUrl = "https://fixture.invalid/team/pi-dependency-acceptance-git-source";
  const gitConfig = join(root, "local-git.config");
  writeFileSync(gitConfig, `[user]\nname = Fixture\nemail = fixture@example.invalid\n[commit]\ngpgSign = false\n[tag]\ngpgSign = false\n[credential]\nhelper =\n[protocol]\nallow = never\n[protocol "file"]\nallow = always\n[url "${pathToFileURL(join(root, "git-repos", sourceName)).href}"]\ninsteadOf = ${sourceUrl}\n`);
  const gitEnv = { ...env, GIT_CONFIG_GLOBAL: gitConfig, GIT_TERMINAL_PROMPT: "0" };
  const gitCommands = [];
  const git = (args, cwd) => {
    const result = spawnSync(join(bin, "git"), args, { cwd, env: gitEnv, encoding: "utf8", timeout: 30000 });
    gitCommands.push({ args, cwd, code: result.status, stdout: result.stdout, stderr: result.stderr });
    writeFileSync(join(root, "git-fixture-commands.json"), JSON.stringify(gitCommands, null, 2) + "\n");
    assert.equal(result.status, 0, `local git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const createGitFixture = (name, dependencies = {}) => {
    const directory = join(root, "git-repos", name);
    mkdirSync(directory, { recursive: true });
    git(["init", "--initial-branch=main"], directory);
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", dependencies }));
    writeFileSync(join(directory, "payload.txt"), `${name}:marker-1\n`);
    writeFileSync(join(directory, ".gitignore"), "node_modules/\n");
    git(["add", "package.json", "payload.txt", ".gitignore"], directory);
    git(["commit", "-m", "Fixture marker 1"], directory);
    return { name, directory, url: pathToFileURL(directory).href, oldCommit: git(["rev-parse", "HEAD"], directory) };
  };
  const gitPackages = ["head", "branch", "sha", "tag", "unselected"].map(policy => {
    const fixture = { ...createGitFixture(`pi-dependency-git-${policy}`), policy };
    if (policy === "branch") git(["branch", "fixture-branch"], fixture.directory);
    if (policy === "tag") {
      git(["tag", "-a", "fixture-tag", "-m", "Pinned fixture tag"], fixture.directory);
      assert.equal(git(["cat-file", "-t", "refs/tags/fixture-tag"], fixture.directory), "tag");
    }
    fixture.spec = `git+${fixture.url}${policy === "branch" ? "#fixture-branch" : policy === "sha" ? `#${fixture.oldCommit}` : policy === "tag" ? "#fixture-tag" : ""}`;
    return fixture;
  });
  const aGitDependencies = Object.fromEntries(gitPackages.filter(pkg => pkg.policy !== "unselected").map(pkg => [pkg.name, pkg.spec]));
  const bGit = gitPackages.find(pkg => pkg.policy === "unselected");
  const sourceFixture = createGitFixture(sourceName, { [sourceLeaf]: "^1.0.0" });
  const sourceSpec = `git:${sourceUrl}@${sourceFixture.oldCommit}`;
  const packages = [
    { name: a, version: "1.0.0", dependencies: { [bridge]: "^1.0.0", [fixed]: "1.0.0", ...aGitDependencies } },
    { name: b, version: "1.0.0", dependencies: { [leaf]: "^2.0.0", [unselected]: "^1.0.0", [bGit.name]: bGit.spec } },
    { name: b, version: "2.0.0", dependencies: { [leaf]: "^2.0.0", [unselected]: "^1.0.0", [bGit.name]: bGit.spec } },
    { name: c, version: "1.0.0", dependencies: { [leaf]: "^2.0.0" } },
    { name: c, version: "1.1.0", dependencies: { [leaf]: "^2.0.0" } },
    { name: bridge, version: "1.0.0", dependencies: { [leaf]: "^2.0.0" } },
    { name: leaf, version: "2.0.0", dependencies: {} },
    { name: leaf, version: "2.1.0", dependencies: {} },
    { name: leaf, version: "2.2.0", dependencies: {} },
    { name: leaf, version: "3.0.0", dependencies: {} },
    { name: fixed, version: "1.0.0", dependencies: {} },
    { name: fixed, version: "1.1.0", dependencies: {} },
    { name: unselected, version: "1.0.0", dependencies: {} },
    { name: unselected, version: "1.1.0", dependencies: {} },
    { name: sourceLeaf, version: "1.0.0", dependencies: {} },
    { name: sourceLeaf, version: "1.1.0", dependencies: {} },
  ];
  const archives = new Map();
  for (const pkg of packages) {
    const directory = join(root, "dependency-registry", `${pkg.name}-${pkg.version}`);
    mkdirSync(join(directory, "package"), { recursive: true });
    writeFileSync(join(directory, "package", "package.json"), JSON.stringify(pkg));
    writeFileSync(join(directory, "package", "payload.txt"), `${pkg.name}@${pkg.version}\n`);
    const archive = join(directory, "package.tgz");
    const packed = spawnSync("tar", ["-czf", archive, "-C", directory, "package"], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    archives.set(`${pkg.name}/${pkg.version}`, readFileSync(archive));
  }
  let phase = 0, base;
  const requests = [];
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url?.slice(1) ?? "");
    requests.push({ phase, path });
    const archive = archives.get(path.replace(/\.tgz$/, ""));
    if (archive) return response.end(archive);
    const visible = packages.filter(pkg => {
      if (pkg.name !== path) return false;
      if ((pkg.name === c || pkg.name === unselected) && pkg.version === "1.1.0") return phase >= 2;
      if (pkg.name === leaf && pkg.version === "2.2.0") return phase >= 2;
      if (pkg.name === sourceLeaf && pkg.version === "1.1.0") return phase >= 3;
      return phase >= 1 || pkg.version === (pkg.name === leaf ? "2.0.0" : "1.0.0");
    });
    if (!visible.length) { response.writeHead(404); return response.end("{}"); }
    const versions = Object.fromEntries(visible.map(pkg => [pkg.version, {
      ...pkg, dist: { tarball: `${base}/${pkg.name}/${pkg.version}.tgz`, shasum: createHash("sha1").update(archives.get(`${pkg.name}/${pkg.version}`)).digest("hex") },
    }]));
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ name: path, "dist-tags": { latest: visible.at(-1).version }, versions,
      time: Object.fromEntries(visible.map(pkg => [pkg.version, "2020-01-01T00:00:00.000Z"])) }));
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  base = `http://127.0.0.1:${server.address().port}`;
  const registryEnv = { ...gitEnv, npm_config_registry: base, BUN_INSTALL_CACHE_DIR: join(root, "dependency-cache") };
  const manifest = join(env.PI_CODING_AGENT_DIR, "npm", "package.json");
  const installedVersion = name => JSON.parse(readFileSync(join(env.PI_CODING_AGENT_DIR, "npm", "node_modules", name, "package.json"), "utf8")).version;
  const installedState = () => Object.fromEntries([a, b, c, bridge, leaf, fixed, unselected].map(name => {
    const pkg = JSON.parse(readFileSync(join(env.PI_CODING_AGENT_DIR, "npm", "node_modules", name, "package.json"), "utf8"));
    return [name, { version: pkg.version, dependencies: pkg.dependencies,
      payload: readFileSync(join(env.PI_CODING_AGENT_DIR, "npm", "node_modules", name, "payload.txt"), "utf8") }];
  }));
  const gitState = lock => Object.fromEntries(gitPackages.map(({ name }) => {
    const directory = realpathSync(join(dirname(manifest), "node_modules", name));
    const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    return [name, { name: pkg.name, version: pkg.version, payload: readFileSync(join(directory, "payload.txt"), "utf8"), lock: lock.packages[name] }];
  }));
  const assertGitState = (state, advanced = false) => {
    for (const fixture of gitPackages) {
      const selected = advanced && (fixture.policy === "head" || fixture.policy === "branch");
      const commit = selected ? fixture.newCommit : fixture.oldCommit;
      const actual = state[fixture.name];
      assert.equal(actual.name, fixture.name, "Git dependency must not be an alias");
      assert.equal(actual.version, "1.0.0", "Git payload updates must not depend on semver changes");
      assert.equal(actual.payload, `${fixture.name}:marker-${selected ? 2 : 1}\n`);
      assert.ok(Array.isArray(actual.lock), `missing native Git lock record for ${fixture.name}`);
      assert.ok(actual.lock.some(value => typeof value === "string" && (value === commit || value.endsWith(`#${commit}`))), `native Git lock does not record ${commit} for ${fixture.name}`);
    }
  };
  let sourceInstalledPath;
  const detector = join(root, "dependency-detector.ts");
  writeFileSync(detector, `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
export default function(pi) {
  pi.registerCommand("dependency-acceptance-check", { description: "Check installed runtime dependencies", handler: async (_args, context) => {
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const settingsManager = SettingsManager.create(context.cwd, agentDir, { projectTrusted: false });
    const manager = new DefaultPackageManager({ cwd: context.cwd, agentDir, settingsManager });
    const updates = await manager.checkForAvailableUpdates();
    // Parse the native lock with the target's embedded Bun, not an external runtime.
    writeFileSync(process.env.PI_DEPENDENCY_CHECK_OUTPUT + ".lock.json", JSON.stringify(Bun.JSONC.parse(readFileSync(join(agentDir, "npm", "bun.lock"), "utf8"))));
    const sourceRoot = manager.getInstalledPath(${JSON.stringify(sourceSpec)}, "user");
    if (sourceRoot) writeFileSync(process.env.PI_DEPENDENCY_CHECK_OUTPUT + ".source.json", JSON.stringify({ root: sourceRoot, lock: Bun.JSONC.parse(readFileSync(join(sourceRoot, "bun.lock"), "utf8")) }));
    writeFileSync(process.env.PI_DEPENDENCY_CHECK_OUTPUT, JSON.stringify(updates));
  }});
}\n`);
  const check = async label => {
    const output = join(root, `${label}.json`);
    const before = Object.fromEntries([manifest, join(env.PI_CODING_AGENT_DIR, "settings.json"), ...["bun.lock", "bun.lockb", "package-lock.json"].map(name => join(env.PI_CODING_AGENT_DIR, "npm", name)), ...(sourceInstalledPath ? ["package.json", "bun.lock", "untracked-sentinel"].map(name => join(sourceInstalledPath, name)) : [])].filter(existsSync).map(path => [path, hash(path)]));
    await run(label, ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", detector, "--no-skills", "--no-prompt-templates"], {
      env: { ...registryEnv, PI_DEPENDENCY_CHECK_OUTPUT: output },
      input: '{"id":"dependency-check","type":"prompt","message":"/dependency-acceptance-check"}\n', untilFile: output, timeout: 30000,
    });
    for (const [path, value] of Object.entries(before)) assert.equal(hash(path), value, `dependency check mutated ${path}`);
    return JSON.parse(readFileSync(output, "utf8"));
  };
  try {
    await run("dependency-install-a", ["install", `npm:${a}@1.0.0`], { env: registryEnv });
    await run("dependency-install-b", ["install", `npm:${b}@1.0.0`], { env: registryEnv });
    assert.equal(installedVersion(leaf), "2.0.0");
    phase = 1;
    const updates = await check("dependency-check-before");
    assert.ok(updates.some(update => update.source === `npm:${a}@1.0.0`), "unchanged pinned plugin must advertise its indirect dependency update");
    assert.equal(installedVersion(leaf), "2.0.0", "detection installed a dependency");
    const manifestBefore = hash(manifest);
    await run("dependency-targeted-update", ["update", `npm:${a}@1.0.0`], { env: registryEnv });
    assert.equal(installedVersion(leaf), "2.1.0");
    assert.equal(installedVersion(a), "1.0.0");
    assert.equal(installedVersion(b), "1.0.0");
    assert.equal(installedVersion(fixed), "1.0.0");
    assert.equal(hash(manifest), manifestBefore, "dependency refresh rewrote plugin source declarations");
    assert.deepEqual(await check("dependency-check-after"), [], "completed dependency update was advertised again");
    receipt.dependencyUpdates = { directAndIndirect: true, shared: true, sourcePinsPreserved: true, exactDependencyPreserved: true, outOfRangeRejected: true, checkReadOnly: true, noRepeatedUpdate: true };
    save();

    await run("combined-install-c", ["install", `npm:${c}`], { env: registryEnv });
    assert.deepEqual(await check("combined-cache-warm"), [], "fixture must be current before new metadata is published");
    const before = installedState();
    assert.equal(before[c].version, "1.0.0");
    assert.equal(before[c].payload, `${c}@1.0.0\n`);
    assert.equal(before[leaf].version, "2.1.0");
    assert.equal(before[unselected].version, "1.0.0");
    const combinedManifestBefore = JSON.parse(readFileSync(manifest, "utf8"));
    const settingsBefore = hash(join(env.PI_CODING_AGENT_DIR, "settings.json"));
    phase = 2;
    const combinedUpdates = await check("combined-check-before");
    assert.ok(combinedUpdates.some(update => update.source === `npm:${c}` && update.reason === "both"), "cached unpinned C must advertise both its own and dependency updates");
    assert.ok(combinedUpdates.some(update => update.source === `npm:${b}@1.0.0` && update.reason === "dependencies"), "unselected B subtree must have an independently available update");
    const lockBefore = JSON.parse(readFileSync(join(root, "combined-check-before.json.lock.json"), "utf8"));
    assert.equal(lockBefore.packages[c][0], `${c}@1.0.0`);
    assert.equal(lockBefore.packages[leaf][0], `${leaf}@2.1.0`);
    assert.equal(lockBefore.packages[unselected][0], `${unselected}@1.0.0`);
    receipt.combinedUpdates = { complete: false, cache: registryEnv.BUN_INSTALL_CACHE_DIR, before, noticesBefore: combinedUpdates,
      manifestBefore: combinedManifestBefore, lockBefore: lockBefore.packages };
    save();
    await run("combined-targeted-update", ["update", `npm:${c}`], { env: registryEnv });
    const noticesAfter = await check("combined-check-after");
    const after = installedState();
    const lockAfter = JSON.parse(readFileSync(join(root, "combined-check-after.json.lock.json"), "utf8"));
    const manifestAfter = JSON.parse(readFileSync(manifest, "utf8"));
    Object.assign(receipt.combinedUpdates, { after, noticesAfter, manifestAfter, lockAfter: lockAfter.packages });
    save();
    assert.equal(after[c].version, "1.1.0", "targeted update reused cached C 1.0.0");
    assert.equal(after[c].payload, `${c}@1.1.0\n`, "targeted update did not replace C's actual payload");
    assert.equal(after[leaf].version, "2.2.0");
    assert.equal(after[leaf].payload, `${leaf}@2.2.0\n`);
    for (const name of [b, c, bridge]) assert.equal(after[name].dependencies[leaf], "^2.0.0", `shared leaf no longer satisfies ${name}'s authored range`);
    for (const name of [a, b, bridge, fixed, unselected]) assert.deepEqual(after[name], before[name], `targeted C update changed unselected ${name}`);
    assert.deepEqual(lockAfter.packages[unselected], lockBefore.packages[unselected], "targeted C update changed unselected B subtree's native lock record");
    assert.equal(lockAfter.packages[c][0], `${c}@1.1.0`);
    assert.equal(lockAfter.packages[leaf][0], `${leaf}@2.2.0`);
    // Unpinned npm:C is refreshed by the fork as C@latest; only that generated entry may change.
    assert.deepEqual(manifestAfter, { ...combinedManifestBefore, dependencies: { ...combinedManifestBefore.dependencies, [c]: "latest" } }, "combined update changed declarations beyond C's expected latest transition");
    assert.equal(hash(join(env.PI_CODING_AGENT_DIR, "settings.json")), settingsBefore, "combined update changed configured source constraints");
    assert.deepEqual(noticesAfter.map(({ source, reason }) => ({ source, reason })), [{ source: `npm:${b}@1.0.0`, reason: "dependencies" }], "C's completed update must disappear while B's unselected update remains");
    receipt.combinedUpdates.complete = true;
    save();
    await run("combined-remove-c", ["remove", `npm:${c}`], { env: registryEnv });
    await run("dependency-remove-a", ["remove", `npm:${a}@1.0.0`], { env: registryEnv });
    await run("dependency-remove-b", ["remove", `npm:${b}@1.0.0`], { env: registryEnv });

    // Preserve all original checks through cleanup, then establish a fresh Git-only baseline.
    await run("git-dependency-install-a", ["install", `npm:${a}@1.0.0`], { env: registryEnv });
    await run("git-dependency-install-b", ["install", `npm:${b}@1.0.0`], { env: registryEnv });
    await run("git-dependency-install-c", ["install", `npm:${c}@1.1.0`], { env: registryEnv });
    // Bootstrap only: normalize cached registry installs before testing Git capability.
    await run("git-dependency-registry-bootstrap", ["update", `npm:${a}@1.0.0`], { env: registryEnv });
    const gitBaselineNotices = await check("git-dependency-baseline");
    const gitLockBefore = JSON.parse(readFileSync(join(root, "git-dependency-baseline.json.lock.json"), "utf8"));
    const gitBefore = gitState(gitLockBefore);
    const registryBefore = installedState();
    const manifestHashes = Object.fromEntries([manifest, join(env.PI_CODING_AGENT_DIR, "settings.json"), ...[a, b, c, bridge, leaf, fixed, unselected, ...gitPackages.map(pkg => pkg.name)].map(name => join(dirname(manifest), "node_modules", name, "package.json"))].map(path => [path, hash(path)]));
    const assertManifestsUnchanged = () => {
      for (const [path, value] of Object.entries(manifestHashes)) assert.equal(hash(path), value, `Git dependency update rewrote ${path}`);
    };
    receipt.floatingGit = { complete: false, setupComplete: false, priorChecksComplete: receipt.dependencyUpdates.checkReadOnly && receipt.combinedUpdates.complete,
      repos: gitPackages, before: gitBefore, registryBefore, baselineNotices: gitBaselineNotices, manifestHashes };
    save();
    assert.equal(installedVersion(a), "1.0.0");
    assert.equal(installedVersion(b), "1.0.0");
    assert.equal(installedVersion(c), "1.1.0");
    assert.equal(installedVersion(leaf), "2.2.0", "Git-only phase must not have a registry leaf update pending");
    assert.equal(installedVersion(fixed), "1.0.0");
    assert.ok(!gitBaselineNotices.some(update => update.source === `npm:${a}@1.0.0`), "A must be current before Git remotes advance");
    assertGitState(gitBefore);
    receipt.floatingGit.setupComplete = true;
    for (const fixture of gitPackages) {
      if (fixture.policy === "branch") git(["checkout", "fixture-branch"], fixture.directory);
      writeFileSync(join(fixture.directory, "payload.txt"), `${fixture.name}:marker-2\n`);
      git(["add", "payload.txt"], fixture.directory);
      git(["commit", "-m", "Fixture marker 2"], fixture.directory);
      fixture.newCommit = git(["rev-parse", "HEAD"], fixture.directory);
      if (fixture.policy === "branch") {
        git(["checkout", "main"], fixture.directory);
        assert.equal(git(["rev-parse", "HEAD"], fixture.directory), fixture.oldCommit);
      }
      if (fixture.policy === "tag") assert.equal(git(["rev-parse", "fixture-tag^{commit}"], fixture.directory), fixture.oldCommit);
    }
    save();
    const gitNotices = await check("git-dependency-check-before");
    receipt.floatingGit.noticesBefore = gitNotices;
    save();
    assert.deepEqual(gitState(JSON.parse(readFileSync(join(root, "git-dependency-check-before.json.lock.json"), "utf8"))), gitBefore, "Git detection installed or changed a dependency");
    assert.ok(gitNotices.some(update => update.source === `npm:${a}@1.0.0` && update.reason === "dependencies"), "floating Git dependencies of pinned A must be advertised");
    assert.ok(gitNotices.some(update => update.source === `npm:${b}@1.0.0` && update.reason === "dependencies"), "unselected B Git dependency must remain independently updatable");
    await run("git-dependency-targeted-update", ["update", `npm:${a}@1.0.0`], { env: registryEnv });
    const gitNoticesAfter = await check("git-dependency-check-after");
    const gitLockAfter = JSON.parse(readFileSync(join(root, "git-dependency-check-after.json.lock.json"), "utf8"));
    const gitAfter = gitState(gitLockAfter);
    Object.assign(receipt.floatingGit, { after: gitAfter, noticesAfter: gitNoticesAfter, lockAfter: gitLockAfter.packages });
    save();
    assertGitState(gitAfter, true);
    assert.deepEqual(gitAfter[bGit.name], gitBefore[bGit.name], "targeted A update changed unselected B Git payload or native lock");
    assert.deepEqual(installedState(), registryBefore, "Git-only update changed a registry package or authored dependency");
    assertManifestsUnchanged();
    assert.deepEqual(gitNoticesAfter.map(({ source, reason }) => ({ source, reason })), [{ source: `npm:${b}@1.0.0`, reason: "dependencies" }], "A must clear while B's legitimate Git update remains");

    const nativeLockPath = join(dirname(manifest), "bun.lock"), nativeLockHash = hash(nativeLockPath);
    const modules = join(realpathSync(dirname(manifest)), "node_modules");
    assert.ok(modules.startsWith(`${realpathSync(root)}/`), "refusing to remove node_modules outside receipt");
    assert.equal(realpathSync(modules), modules, "managed node_modules must be an owned directory, not a symlink");
    rmSync(modules, { recursive: true });
    await run("git-dependency-frozen-replay", ["install", "--cwd", dirname(manifest), "--frozen-lockfile", "--ignore-scripts", "--omit=peer"], { env: { ...registryEnv, BUN_BE_BUN: "1" } });
    assert.equal(hash(nativeLockPath), nativeLockHash, "frozen replay rewrote the native lock");
    assertManifestsUnchanged();
    const replayNotices = await check("git-dependency-replay-check");
    const replayState = gitState(JSON.parse(readFileSync(join(root, "git-dependency-replay-check.json.lock.json"), "utf8")));
    assertGitState(replayState, true);
    assert.deepEqual(replayState, gitAfter, "native Git lock did not replay selected/new and unselected/pinned/old payloads");
    assert.deepEqual(installedState(), registryBefore);
    assert.deepEqual(replayNotices.map(({ source, reason }) => ({ source, reason })), [{ source: `npm:${b}@1.0.0`, reason: "dependencies" }]);
    Object.assign(receipt.floatingGit, { complete: true, frozenReplay: true, replayState, nativeLockHash });
    save();

    await run("source-git-install", ["install", sourceSpec], { env: registryEnv });
    await check("source-git-baseline");
    const sourceBefore = JSON.parse(readFileSync(join(root, "source-git-baseline.json.source.json"), "utf8"));
    sourceInstalledPath = realpathSync(sourceBefore.root);
    assert.ok(sourceInstalledPath.startsWith(`${realpathSync(env.PI_CODING_AGENT_DIR)}/`), "Git source must be receipt-owned");
    const sentinel = join(sourceInstalledPath, "untracked-sentinel");
    assert.ok(!existsSync(sentinel));
    writeFileSync(sentinel, "preserve Git source sentinel\n");
    assert.equal(git(["status", "--porcelain", "--", "untracked-sentinel"], sourceInstalledPath), "?? untracked-sentinel");
    const sourceHead = git(["rev-parse", "HEAD"], sourceInstalledPath);
    assert.equal(sourceHead, sourceFixture.oldCommit);
    const sourceManifestHash = hash(join(sourceInstalledPath, "package.json"));
    const sourceLockHash = hash(join(sourceInstalledPath, "bun.lock"));
    assert.equal(sourceBefore.lock.packages[sourceLeaf][0], `${sourceLeaf}@1.0.0`);
    assert.equal(readFileSync(join(realpathSync(join(sourceInstalledPath, "node_modules", sourceLeaf)), "payload.txt"), "utf8"), `${sourceLeaf}@1.0.0\n`);
    phase = 3;
    const sourceNotices = await check("source-git-check-before");
    assert.ok(sourceNotices.some(update => update.source === sourceSpec && update.reason === "dependencies"), "fixed-SHA Git source must advertise its registry dependency update");
    await run("source-git-targeted-update", ["update", sourceSpec], { env: registryEnv });
    const sourceNoticesAfter = await check("source-git-check-after");
    const sourceAfter = JSON.parse(readFileSync(join(root, "source-git-check-after.json.source.json"), "utf8"));
    assert.equal(git(["rev-parse", "HEAD"], sourceInstalledPath), sourceHead);
    assert.equal(hash(join(sourceInstalledPath, "package.json")), sourceManifestHash);
    assert.equal(readFileSync(sentinel, "utf8"), "preserve Git source sentinel\n");
    assert.notEqual(hash(join(sourceInstalledPath, "bun.lock")), sourceLockHash, "Git source generated lock did not refresh");
    assert.equal(sourceAfter.lock.packages[sourceLeaf][0], `${sourceLeaf}@1.1.0`);
    assert.equal(readFileSync(join(realpathSync(join(sourceInstalledPath, "node_modules", sourceLeaf)), "payload.txt"), "utf8"), `${sourceLeaf}@1.1.0\n`);
    assert.ok(!sourceNoticesAfter.some(update => update.source === sourceSpec), "completed Git source dependency update was advertised again");
    receipt.gitSourceUpdates = { complete: true, source: sourceSpec, head: sourceHead, manifestHash: sourceManifestHash,
      sentinelPreserved: true, lockBefore: sourceBefore.lock, lockAfter: sourceAfter.lock };
    save();
    await run("source-git-remove", ["remove", sourceSpec], { env: registryEnv });
    await run("git-dependency-remove-c", ["remove", `npm:${c}@1.1.0`], { env: registryEnv });
    await run("git-dependency-remove-a", ["remove", `npm:${a}@1.0.0`], { env: registryEnv });
    await run("git-dependency-remove-b", ["remove", `npm:${b}@1.0.0`], { env: registryEnv });
  } finally {
    writeFileSync(join(root, "dependency-registry-requests.json"), JSON.stringify(requests, null, 2) + "\n");
    server.closeAllConnections();
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
  if (mode !== "--dependencies-only") {
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
  }
  await verifyFloatingDependencies();
  assert.equal(hash(entry), receipt.entrySha256, "candidate changed during acceptance");
  receipt.complete = true; save();
  console.log(`PASS installed package lifecycle: ${basename(entry)}; ${root}`);
} catch (error) {
  receipt.error = String(error); save(); throw error;
}
