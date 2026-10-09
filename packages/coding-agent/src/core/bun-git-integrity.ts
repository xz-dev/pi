import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { stripBom } from "../utils/text.ts";

/** Keep npm's Git packing hashes out of Bun's GitHub archive verification (xz-dev/pi#6). */
export async function withBunGitIntegrityCompatibility(cwd: string, install: () => Promise<void>): Promise<void> {
	const path = join(cwd, "package-lock.json");
	if (!existsSync(path)) return install();

	// Serialize temporary edits across Pi instances; never read another install's normalized input.
	const release = await lockfile.lock(path, { retries: { retries: 10, minTimeout: 100, maxTimeout: 1000 } });
	try {
		// Native Bun locks already contain Bun's own hashes. Bun 1.4.2 migrates package-lock.json,
		// not npm-shrinkwrap.json; leave both native locks and shrinkwrap files untouched.
		if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return await install();
		const original = readFileSync(path);
		let parsed: unknown;
		try {
			parsed = JSON.parse(stripBom(original.toString("utf8")));
		} catch {
			return await install(); // Let Bun report invalid/unsupported input rather than repairing it.
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return await install();
		const data = parsed as Record<string, unknown>;
		if (data.lockfileVersion !== 2 && data.lockfileVersion !== 3) return await install();
		if (!data.packages || typeof data.packages !== "object" || Array.isArray(data.packages)) return await install();

		let changed = false;
		for (const [location, value] of Object.entries(data.packages)) {
			if (!location || !value || typeof value !== "object" || Array.isArray(value)) continue;
			const entry = value as Record<string, unknown>;
			if (
				typeof entry.resolved === "string" &&
				/^git\+(?:https?|ssh):\/\/[^#\s]+#[a-f\d]{40}$/i.test(entry.resolved) &&
				typeof entry.integrity === "string"
			) {
				// Retain the exact Git commit. Registry and HTTP tarball checks must not be weakened.
				delete entry.integrity;
				changed = true;
			}
		}
		if (!changed) return await install();
		try {
			writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
			await install();
		} finally {
			writeFileSync(path, original);
		}
	} finally {
		await release();
	}
}
