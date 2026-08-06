import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-notices-")); const bundle = join(root, "bundle");
	mkdirSync(join(bundle, "node_modules", "@mariozechner", "clipboard-native"), { recursive: true });
	writeFileSync(join(bundle, "node_modules", "@mariozechner", "clipboard-native", "package.json"), JSON.stringify({ name: "@mariozechner/clipboard-native", version: "1.0.0", license: "MIT" }));
	writeFileSync(join(bundle, "node_modules", "@mariozechner", "clipboard-native", "LICENSE.txt"), "fixture license\n");
	writeFileSync(join(bundle, "node_modules", "@mariozechner", "clipboard-native", "NOTICE.md"), "fixture notice\n");
	const lock = { lockfileVersion: 3, packages: { "packages/coding-agent": { name: "@earendil-works/pi-coding-agent", dependencies: { alpha: "1.0.0", "proper-lockfile": "4.1.2", "p-retry": "4.6.2" }, optionalDependencies: { "@mariozechner/clipboard": "1.0.0" } }, "node_modules/alpha": { version: "1.0.0", license: "ISC", dependencies: { beta: "2.0.0" } }, "node_modules/beta": { version: "2.0.0", license: "MIT" }, "node_modules/@mariozechner/clipboard": { version: "1.0.0", license: "MIT" }, "node_modules/proper-lockfile": { version: "4.1.2", license: "MIT", dependencies: { retry: "0.12.0" } }, "node_modules/proper-lockfile/node_modules/retry": { version: "0.12.0", license: "MIT" }, "node_modules/p-retry": { version: "4.6.2", license: "MIT", dependencies: { retry: "0.13.1", "@types/retry": "0.12.0" } }, "node_modules/p-retry/node_modules/@types/retry": { version: "0.12.0", license: "MIT" }, "node_modules/retry": { version: "0.13.1", license: "MIT" }, "node_modules/@types/retry": { version: "0.12.5", license: "MIT" } } };
	const lockPath = join(root, "package-lock.json"); writeFileSync(lockPath, JSON.stringify(lock)); return { root, bundle, lockPath, output: join(root, "notices.md") };
}

test("notices deterministically cover exact runtime closure and packaged natives", () => {
	const value = fixture(); try {
		execFileSync(process.execPath, [join(import.meta.dirname, "generate-third-party-notices.mjs"), value.bundle, value.output, value.lockPath]); const first = readFileSync(value.output);
		execFileSync(process.execPath, [join(import.meta.dirname, "generate-third-party-notices.mjs"), value.bundle, value.output, value.lockPath]); const second = readFileSync(value.output);
		assert.deepEqual(second, first); const text = first.toString();
		for (const expected of ["## node_modules/alpha@1.0.0\nLicense: ISC", "## node_modules/beta@2.0.0\nLicense: MIT", "## node_modules/@mariozechner/clipboard@1.0.0\nLicense: MIT", "## node_modules/@mariozechner/clipboard-native@1.0.0\nLicense: MIT (packaged native)"]) assert.ok(text.includes(expected));
		assert.match(text, /### LICENSE\.txt\nSHA-256: [0-9a-f]{64}\n\n```text\nfixture license\n```/);
		assert.match(text, /### NOTICE\.md\nSHA-256: [0-9a-f]{64}\n\n```text\nfixture notice\n```/);
		assert.ok(text.indexOf("### LICENSE.txt") < text.indexOf("### NOTICE.md"));
	} finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("real ignore dependency preserves LICENSE-MIT attribution instead of unrelated generic MIT text", () => {
	const output = join(tmpdir(), `pi-ignore-notices-${process.pid}.md`);
	try {
		execFileSync(process.execPath, [join(import.meta.dirname, "generate-third-party-notices.mjs"), join(import.meta.dirname, "..", "packages", "coding-agent"), output]);
		const text = readFileSync(output, "utf8");
		const section = text.slice(text.indexOf("## node_modules/ignore@7.0.5"), text.indexOf("\n## ", text.indexOf("## node_modules/ignore@7.0.5") + 1));
		assert.match(section, /### LICENSE-MIT\nSHA-256: 9c94db23dc4b1e9aaee5d195668b916afc71efed54af226b66cf0ccc4389c1c0/);
		assert.match(section, /Copyright \(c\) 2013 Kael Zhang/);
		assert.doesNotMatch(section, /Copyright 2023 Anthropic/);
	} finally { rmSync(output, { force: true }); }
});

test("nested runtime versions are inventoried by exact lockfile path, never flattened to top-level", () => {
	const value = fixture(); try {
		execFileSync(process.execPath, [join(import.meta.dirname, "generate-third-party-notices.mjs"), value.bundle, value.output, value.lockPath]);
		const text = readFileSync(value.output).toString();
		// exact nested lockfile paths carry their own runtime versions
		for (const expected of ["## node_modules/proper-lockfile/node_modules/retry@0.12.0\nLicense: MIT", "## node_modules/p-retry/node_modules/@types/retry@0.12.0\nLicense: MIT"]) assert.ok(text.includes(expected));
		// genuinely required top-level versions stay under their exact paths
		assert.ok(text.includes("## node_modules/retry@0.13.1\nLicense: MIT"));
		// no wrong top-level substitution: nothing in the closure requires @types/retry@0.12.5
		assert.ok(!text.includes("@types/retry@0.12.5"));
		// every inventoried heading is an exact lockfile path/version, not a flattened or renamed path
		const lock = JSON.parse(readFileSync(value.lockPath, "utf8"));
		for (const match of text.matchAll(/^## (.+)@([^\n]+)$/gm)) {
			const [path, version] = [match[1], match[2]];
			if (lock.packages[path]) assert.equal(lock.packages[path].version, version);
		}
	} finally { rmSync(value.root, { recursive: true, force: true }); }
});
