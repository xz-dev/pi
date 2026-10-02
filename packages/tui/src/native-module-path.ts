import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRequire = createRequire(import.meta.url);
const TUI_PACKAGE_NAME = "@earendil-works/pi-tui";

/** True when running inside a `bun build --compile` executable (`/$bunfs`). */
const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/**
 * The single-executable build registers its materialized-native-dir provider on
 * `globalThis` so this package never imports the coding-agent module graph (no
 * circular dependency, no module resolution inside the binary).
 */
const MATERIALIZED_NATIVE_DIR_KEY = Symbol.for("@earendil-works/pi-coding-agent:materialize-native-addons");

function getMaterializedNativeDir(): string | undefined {
	if (!isBunBinary) return undefined;
	const provider = (globalThis as Record<symbol, unknown>)[MATERIALIZED_NATIVE_DIR_KEY];
	return typeof provider === "function" ? (provider as () => string | undefined)() : undefined;
}

export interface NativeModuleCandidateOptions {
	moduleUrl?: string;
	execPath?: string;
	resolvePackage?: (specifier: string) => string;
}

export function getNativeModuleCandidates(nativePath: string, options: NativeModuleCandidateOptions = {}): string[] {
	const moduleDir = dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
	const candidates: string[] = [];

	try {
		const packageEntry = (options.resolvePackage ?? moduleRequire.resolve)(TUI_PACKAGE_NAME);
		candidates.push(join(dirname(packageEntry), "..", nativePath));
	} catch {
		// Standalone binaries do not have an installed TUI package.
	}

	const materializedNativeDir = getMaterializedNativeDir();
	if (materializedNativeDir) {
		// nativePath already starts with `native/<platform>/...`.
		candidates.push(join(dirname(materializedNativeDir), nativePath));
	}

	candidates.push(
		join(moduleDir, "..", nativePath),
		join(moduleDir, nativePath),
		join(dirname(options.execPath ?? process.execPath), nativePath),
	);
	return Array.from(new Set(candidates));
}
