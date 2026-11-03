import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function sessionCompressionCliFixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-offline-cli-fixture-"));
	const path = join(root, "cli.mjs");
	writeFileSync(path, `import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { readSessionJsonlBytes } from ${JSON.stringify(new URL("../lib/session-jsonl.mjs", import.meta.url).href)};
const mode = process.argv[2];
const args = process.argv.slice(3);
const agent = process.env.PI_CODING_AGENT_DIR;
if (mode === "runtime") writeFileSync(join(dirname(agent), "extension-loaded"), "loaded");
const flag = args.find(value => value.startsWith("--enable-compress-sessions="));
const value = flag?.split("=")[1];
if (value !== "true" && value !== "false") {
 console.error("requires true or false"); process.exit(1);
}
if (mode === "no-compress") process.exit(0);
const enabled = value === "true";
const position = args.indexOf("--session-dir");
const custom = position >= 0 && mode !== "wrong-scope" ? args[position + 1] : undefined;
const base = join(agent, "sessions");
const dirs = custom ? [custom] : readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(base, e.name));
let failed = false;
for (const dir of dirs) for (const file of readdirSync(dir).filter(name => name.endsWith(".jsonl"))) {
 const path = join(dir, file);
 try {
  const plain = readSessionJsonlBytes(path);
  writeFileSync(path, enabled ? zstdCompressSync(plain) : plain);
 } catch {
  failed = true;
  if (mode === "mutate-failure") writeFileSync(path, "");
 }
}
if (failed) { console.error("Partial migration"); process.exit(1); }
if (mode !== "no-pref") {
 const path = join(agent, "settings.json");
 const settings = JSON.parse(readFileSync(path, "utf8"));
 settings.enableCompressSessions = enabled;
 writeFileSync(path, JSON.stringify(settings));
}
`);
	return { root, path };
}

