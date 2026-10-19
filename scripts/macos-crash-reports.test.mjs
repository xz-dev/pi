import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectMacosCrashReports, crashReportIdentity } from "./lib/macos-crash-reports.mjs";

const ips = (metadata, report) => `${JSON.stringify(metadata)}\n${JSON.stringify(report)}\n`;

test("ips identity parses the metadata line and report body pid", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ips-identity-"));
	try {
		const file = join(root, "pi-2026-10-18-120000.ips");
		writeFileSync(file, ips({ app_name: "pi", timestamp: "2026-10-18 12:00:00.00 +0000" }, { pid: 4242, procName: "pi", captureTime: "2026-10-18 12:00:00.50 +0000" }));
		const identity = crashReportIdentity(file);
		assert.equal(identity.pid, 4242);
		assert.equal(identity.name, "pi");
		assert.equal(identity.timeMs, Date.parse("2026-10-18T12:00:00.500Z"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test(".crash identity parses the Process line pid and Date/Time", () => {
	const identity = crashReportIdentity("/virtual/x.crash", () => `Process:               pi [777]\nPath:                  /opt/pi\nDate/Time:             2026-10-18 12:00:01.000 +0000\n`);
	assert.equal(identity.pid, 777);
	assert.equal(identity.name, "pi");
	assert.equal(identity.timeMs, Date.parse("2026-10-18T12:00:01.000Z"));
});

test("identities honor nonzero timezone offsets in .ips and .crash", () => {
	for (const [zone, expected] of [["-0700", "2026-10-18T19:00:00.500Z"], ["+0530", "2026-10-18T06:30:00.500Z"], ["+0800", "2026-10-18T04:00:00.500Z"]]) {
		const ipsIdentity = crashReportIdentity("/virtual/x.ips", () => `${JSON.stringify({ app_name: "pi", timestamp: `2026-10-18 12:00:00.00 ${zone}` })}\n${JSON.stringify({ pid: 1, procName: "pi", captureTime: `2026-10-18 12:00:00.50 ${zone}` })}\n`);
		assert.equal(ipsIdentity.timeMs, Date.parse(expected), `.ips ${zone}`);
		const crashIdentity = crashReportIdentity("/virtual/x.crash", () => `Process:               pi [1]\nDate/Time:             2026-10-18 12:00:00.500 ${zone}\n`);
		assert.equal(crashIdentity.timeMs, Date.parse(expected), `.crash ${zone}`);
	}
});

test("collection retains bounded matching report content after the source is gone", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ips-content-"));
	try {
		const inside = "2026-10-18 12:00:10.00 -0700";
		const insideUtc = "2026-10-18T19:00:10.000Z";
		writeFileSync(join(root, "stack.ips"), ips({ app_name: "pi", timestamp: inside }, { pid: 900, captureTime: inside, frames: ["SCOPED_CRASH_STACK_SENTINEL"] }));
		writeFileSync(join(root, "oversize.ips"), ips({ app_name: "pi", timestamp: inside }, { pid: 900, captureTime: inside, frames: ["STACK_HEAD_SENTINEL", "A".repeat(80 * 1024), "STACK_TAIL_SENTINEL"] }));
		writeFileSync(join(root, "outside.ips"), ips({ app_name: "pi", timestamp: "2020-01-01 00:00:00.00 +0000" }, { pid: 900 }) + "STALE_SENTINEL\n");
		const reports = collectMacosCrashReports([root], { pid: 900, names: ["pi"], sinceMs: Date.parse("2026-10-18T19:00:00Z"), untilMs: Date.parse("2026-10-18T19:01:00Z") }, { contentLimit: 64 * 1024 });
		assert.equal(reports.length, 2);
		assert.equal(reports[0].timeMs, Date.parse(insideUtc));
		const stack = reports.find(({ file }) => file === "stack.ips");
		assert.equal(stack.truncated, false);
		assert.match(stack.content, /SCOPED_CRASH_STACK_SENTINEL/);
		const oversize = reports.find(({ file }) => file === "oversize.ips");
		assert.equal(oversize.truncated, true);
		assert.ok(oversize.bytes > 64 * 1024);
		assert.equal(oversize.content.length, 64 * 1024);
		assert.match(oversize.content, /STACK_HEAD_SENTINEL/);
		assert.match(oversize.content, /STACK_TAIL_SENTINEL/);
		// Simulate cleanup: evidence already holds the bytes.
		rmSync(root, { recursive: true, force: true });
		assert.match(stack.content, /SCOPED_CRASH_STACK_SENTINEL/);
		assert.doesNotMatch(JSON.stringify(reports), /STALE_SENTINEL/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("collection stops at the report count limit", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ips-limit-"));
	try {
		const inside = "2026-10-18 12:00:10.00 +0000";
		for (let i = 0; i < 12; i++) writeFileSync(join(root, `r${i}.ips`), ips({ app_name: "pi", timestamp: inside }, { pid: 900, captureTime: inside }));
		const reports = collectMacosCrashReports([root], { pid: 900, names: ["pi"], sinceMs: 0, untilMs: Number.MAX_SAFE_INTEGER });
		assert.equal(reports.length, 8);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("collection matches only this probe window and this child pid", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ips-collect-"));
	try {
		const inside = "2026-10-18 12:00:10.00 +0000";
		const files = {
			"matching-pid.ips": ips({ app_name: "pi", timestamp: inside }, { pid: 900, captureTime: inside }),
			"other-pid.ips": ips({ app_name: "pi", timestamp: inside }, { pid: 901, captureTime: inside }),
			"stale-pid.ips": ips({ app_name: "pi", timestamp: "2020-01-01 00:00:00.00 +0000" }, { pid: 900, captureTime: "2020-01-01 00:00:00.00 +0000" }),
			"future-pid.ips": ips({ app_name: "pi", timestamp: "2030-01-01 00:00:00.00 +0000" }, { pid: 900, captureTime: "2030-01-01 00:00:00.00 +0000" }),
			"matching-name.ips": ips({ app_name: "bun", timestamp: inside }, { notJson: true }),
			"other-name.ips": ips({ app_name: "Mail", timestamp: inside }, { notJson: true }),
			"ignored.txt": "Process: pi [900]\nDate/Time: 2026-10-18 12:00:10 +0000\n",
		};
		// A matching process name cannot establish ownership when the PID is unknown.
		files["matching-name.ips"] = `${JSON.stringify({ app_name: "bun", timestamp: inside })}\ntrailing garbage`;
		for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
		const reports = collectMacosCrashReports(
			[root, join(root, "missing")],
			{ pid: 900, names: ["pi", "bun"], sinceMs: Date.parse("2026-10-18T12:00:00Z"), untilMs: Date.parse("2026-10-18T12:00:59Z") },
		);
		assert.deepEqual(reports.map(({ file }) => file).sort(), ["matching-pid.ips"]);
		assert.equal(reports.find(({ file }) => file === "matching-pid.ips").pid, 900);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("unreadable directories and unparseable reports never throw", () => {
	const reports = collectMacosCrashReports(["/nonexistent-dir"], { pid: 1, names: ["pi"], sinceMs: 0, untilMs: Number.MAX_SAFE_INTEGER });
	assert.deepEqual(reports, []);
	assert.equal(crashReportIdentity("/nonexistent-dir/x.ips"), null);
	mkdirSync(join(tmpdir(), "pi-ips-empty-"), { recursive: true });
});
