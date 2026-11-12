import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	stageWindowsOwnerGate,
	WINDOWS_OWNER_GATE_SOURCES,
	windowsOwnerGateDependencies,
} from "./smoke-windows-owner-gate.mjs";

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-procward-stage-"));
	const source = join(directory, "source");
	const work = join(directory, "work");
	mkdirSync(work, { recursive: true });
	const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
	mkdirSync(source);
	writeFileSync(join(source, "package-lock.json"), JSON.stringify(lock));
	for (const name of WINDOWS_OWNER_GATE_SOURCES) {
		const file = join(source, "packages", "coding-agent", name);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `current:${name}\n`);
	}
	return { directory, source, work, lock };
}

test("Windows staging accepts only actual procward consumer sources, not deleted guardian files", () => {
	const f = fixture();
	try {
		const dependencies = windowsOwnerGateDependencies(f.lock);
		let installs = 0;
		stageWindowsOwnerGate(f.work, {
			source: f.source,
			env: { CI: "true" },
			run(file, args) {
				if (file === "bun") return { status: 0, stdout: args[0] === "--version" ? "1.4.4\n" : `${process.execPath}\n` };
				if (args.includes("install")) {
					installs++;
					assert(args.includes("--ignore-scripts") && args.includes("--save-exact"));
					writeFileSync(
						join(f.work, "package-lock.json"),
						JSON.stringify({
							packages: Object.fromEntries(
								dependencies.map(({ name }) => [`node_modules/${name}`, f.lock.packages[`node_modules/${name}`]]),
							),
						}),
					);
					return { status: 0 };
				}
				return {
					status: 0,
					stdout: JSON.stringify({
						dependencies: Object.fromEntries(dependencies.map((entry) => [entry.name, entry])),
					}),
				};
			},
		});
		assert.equal(installs, 1);
		for (const name of WINDOWS_OWNER_GATE_SOURCES)
			assert.deepEqual(
				readFileSync(join(f.work, "packages", "coding-agent", name)),
				readFileSync(join(f.source, "packages", "coding-agent", name)),
			);
		for (const name of [
			"src/utils/process-owner.ts",
			"test/windows-owner-runtime.mjs",
			"test/fixtures/windows-owner.cs",
			"test/fixtures/windows-owner-ipc.mjs",
			"test/fixtures/windows-owner-launcher.mjs",
		])
			assert.equal(existsSync(join(f.work, "packages", "coding-agent", name)), false);
	} finally {
		rmSync(f.directory, { recursive: true, force: true });
	}
});

test("missing actual procward source fails before dependency installation, not after side effects", () => {
	const f = fixture();
	try {
		rmSync(join(f.source, "packages", "coding-agent", "src/utils/procward.ts"));
		assert.throws(
			() =>
				stageWindowsOwnerGate(f.work, {
					source: f.source,
					env: { CI: "true" },
					run() {
						assert.fail("must not install with an incomplete current source contract");
					},
				}),
			/ENOENT/,
		);
		assert.equal(existsSync(join(f.work, "package.json")), false);
	} finally {
		rmSync(f.directory, { recursive: true, force: true });
	}
});
