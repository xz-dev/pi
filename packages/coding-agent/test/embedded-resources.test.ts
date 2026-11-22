import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
	copyResourceTree,
	getEmbeddedAssetPath,
	getResourceCacheRoot,
	isEmbeddedAssetPath,
	isNonEmptyDirectory,
	materializeNativeAddons,
	materializeResourceTree,
} from "../src/config.ts";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function makeCacheRoot(): string {
	tempDir = mkdtempSync(join(tmpdir(), "pi-resources-test-"));
	return tempDir;
}

function makeSource(): string {
	tempDir = tempDir ?? mkdtempSync(join(tmpdir(), "pi-resources-test-"));
	const source = join(tempDir, "source");
	mkdirSync(join(source, "sub"), { recursive: true });
	writeFileSync(join(source, "top.txt"), "top");
	writeFileSync(join(source, "sub", "nested.txt"), "nested");
	return source;
}

describe("embedded asset paths", () => {
	// Bun's embedded root: B:/~BUN/root on Windows, /$bunfs/root elsewhere.
	const root = process.platform === "win32" ? "B:/~BUN/root" : "/$bunfs/root";

	test("resolve under the bunfs root by basename", () => {
		expect(getEmbeddedAssetPath("docs")).toBe(`${root}/docs`);
		expect(getEmbeddedAssetPath("package.json")).toBe(`${root}/package.json`);
	});

	test("detect embedded asset paths", () => {
		expect(isEmbeddedAssetPath(`${root}/docs`)).toBe(true);
		expect(isEmbeddedAssetPath(root)).toBe(false);
		expect(isEmbeddedAssetPath("/real/path/docs")).toBe(false);
	});
});

describe("copyResourceTree", () => {
	test("copies a nested tree", () => {
		const source = makeSource();
		const target = join(tempDir!, "target");
		copyResourceTree(source, target);
		expect(readFileSync(join(target, "top.txt"), "utf8")).toBe("top");
		expect(readFileSync(join(target, "sub", "nested.txt"), "utf8")).toBe("nested");
	});
});

describe("isNonEmptyDirectory", () => {
	test("false for missing, empty, and non-directory paths", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-resources-test-"));
		expect(isNonEmptyDirectory(join(tempDir, "missing"))).toBe(false);
		const empty = join(tempDir, "empty");
		mkdirSync(empty);
		expect(isNonEmptyDirectory(empty)).toBe(false);
		const file = join(tempDir, "file");
		writeFileSync(file, "x");
		expect(isNonEmptyDirectory(file)).toBe(false);
	});

	test("true for a populated directory", () => {
		expect(isNonEmptyDirectory(makeSource())).toBe(true);
	});
});

describe("materializeResourceTree", () => {
	test("populates a missing cache directory", () => {
		const source = makeSource();
		const cacheRoot = makeCacheRoot();
		const target = materializeResourceTree({ sourceDir: source, relativePath: "docs", cacheRoot });
		expect(target).toBe(join(cacheRoot, "docs"));
		expect(readFileSync(join(target, "top.txt"), "utf8")).toBe("top");
		expect(readFileSync(join(target, "sub", "nested.txt"), "utf8")).toBe("nested");
	});

	test("populates an empty cache directory", () => {
		const source = makeSource();
		const cacheRoot = makeCacheRoot();
		const targetDir = join(cacheRoot, "docs");
		mkdirSync(targetDir, { recursive: true });
		const target = materializeResourceTree({ sourceDir: source, relativePath: "docs", cacheRoot });
		expect(readFileSync(join(target, "top.txt"), "utf8")).toBe("top");
	});

	test("reuses a nonempty directory without rewriting user changes", () => {
		const source = makeSource();
		const cacheRoot = makeCacheRoot();
		const targetDir = join(cacheRoot, "docs");
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, "top.txt"), "user-edited");
		writeFileSync(join(targetDir, "extra.txt"), "user-added");

		const target = materializeResourceTree({ sourceDir: source, relativePath: "docs", cacheRoot });
		expect(target).toBe(targetDir);
		expect(readFileSync(join(target, "top.txt"), "utf8")).toBe("user-edited");
		expect(readFileSync(join(target, "extra.txt"), "utf8")).toBe("user-added");
	});

	test("isolates materialization by relative path", () => {
		const source = makeSource();
		const cacheRoot = makeCacheRoot();
		const docs = materializeResourceTree({ sourceDir: source, relativePath: "docs", cacheRoot });
		const examples = materializeResourceTree({ sourceDir: source, relativePath: "examples", cacheRoot });
		expect(docs).not.toBe(examples);
		expect(readFileSync(join(examples, "top.txt"), "utf8")).toBe("top");
	});

	test("nested relative paths stay inside the cache root", () => {
		const source = makeSource();
		const cacheRoot = makeCacheRoot();
		const target = materializeResourceTree({
			sourceDir: source,
			relativePath: "native/linux/prebuilds/linux-x64",
			cacheRoot,
		});
		expect(target).toBe(join(cacheRoot, "native", "linux", "prebuilds", "linux-x64"));
		expect(readFileSync(join(target, "top.txt"), "utf8")).toBe("top");
	});
});

describe("materializeNativeAddons", () => {
	test.each([false, true])("returns unavailable for omitted native assets (stale cache: %s)", (staleCache) => {
		// gentoo-zh/overlay#14221: USE=-X must retain clipboard fallbacks.
		expect(existsSync(getEmbeddedAssetPath("native"))).toBe(false);
		const cacheRoot = makeCacheRoot();
		if (staleCache) {
			mkdirSync(join(cacheRoot, "native"));
			writeFileSync(join(cacheRoot, "native", "old-helper.node"), "old +X build");
		}
		expect(materializeNativeAddons(cacheRoot)).toBeUndefined();
	});
});

describe("getResourceCacheRoot", () => {
	test("includes the user id, release target, and version segments", () => {
		const root = getResourceCacheRoot();
		const segments = root.split("/");
		expect(root.startsWith(tmpdir())).toBe(true);
		expect(segments.some((segment) => segment.startsWith("pi-resources-"))).toBe(true);
		// `<user>/<release-target>/<version>` is the tail of the path.
		expect(segments.length).toBeGreaterThanOrEqual(4);
	});
});

test.skipIf(process.platform === "win32")(
	"compiled resolver materializes one executable helper and ignores stale cache when omitted",
	() => {
		const root = makeCacheRoot();
		const assets = join(root, "embedded");
		const owner = join(assets, "process-owner");
		mkdirSync(owner, { recursive: true });
		writeFileSync(join(owner, "procward"), "fixture bytes, never executed");
		chmodSync(join(owner, "procward"), 0o600);
		const loader = join(root, "loader.mjs");
		// Model Bun's virtual file URL and read-only assets without executing a native helper.
		writeFileSync(
			loader,
			`
import { registerHooks } from "node:module";
registerHooks({load(url, context, next) {
 const result = next(url, context);
 if (!url.endsWith("/src/config.ts")) return result;
 let source = String(result.source);
 source = source.replace(/const EMBEDDED_ASSETS_ROOT = [^;]+;/, ${JSON.stringify(`const EMBEDDED_ASSETS_ROOT = ${JSON.stringify(assets)};`)});
 source = source.replace(/export const isBunBinary =[^;]+;/, "export const isBunBinary = true;");
 return { ...result, source };
}});
`,
		);
		const config = fileURLToPath(new URL("../src/config.ts", import.meta.url));
		const result = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				loader,
				"--input-type=module",
				"-e",
				`
import { readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { resolveProcwardBinary } from ${JSON.stringify(config)};
const first = resolveProcwardBinary();
const bytes = readFileSync(first, "utf8");
const mode = statSync(first).mode & 0o777;
writeFileSync(first, "cached-edit");
const second = resolveProcwardBinary();
rmSync(${JSON.stringify(owner)}, { recursive: true });
console.log(JSON.stringify({ first, second, bytes, mode, cached: readFileSync(second, "utf8"), omitted: resolveProcwardBinary() === undefined }));
`,
			],
			{ env: { ...process.env, PI_PROCWARD_BIN: "", PATH: "", TMPDIR: root }, encoding: "utf8", timeout: 6000 },
		);
		expect(result.status, result.stderr).toBe(0);
		const actual = JSON.parse(result.stdout) as {
			first: string;
			second: string;
			bytes: string;
			mode: number;
			cached: string;
			omitted: boolean;
		};
		expect(actual.first).toBe(actual.second);
		expect(actual.first).not.toBe(join(owner, "procward"));
		expect(actual.first.startsWith(root)).toBe(true);
		expect(actual).toMatchObject({
			bytes: "fixture bytes, never executed",
			mode: 0o755,
			cached: "cached-edit",
			omitted: true,
		});
	},
);
