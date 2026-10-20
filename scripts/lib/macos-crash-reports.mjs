import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

// Scoped collection of macOS crash reports (.ips/.crash) for a single crashed
// child: only reports whose parsed PID matches the child and whose report time
// falls inside the probe window are returned. A name alone cannot prove ownership. Everything is best-effort: an
// unreadable directory or unparseable report yields no entry, never a throw.

const IPS_METADATA_KEYS = ["name", "app_name"];

// Matched report content is embedded in the diagnostics artifact: cap per-file
// characters and report count so a hostile or huge DiagnosticReports directory
// stays bounded. Oversized reports retain both ends because headers and stacks
// can occur at different positions; truncation is always explicit.
const REPORT_CONTENT_LIMIT = 1024 * 1024;
const REPORT_COUNT_LIMIT = 8;

function parseTime(value) {
	if (typeof value !== "string") return null;
	// Apple's ` -0700` suffix is not parseable; rewrite to ` -07:00` keeping sign,
	// hours and minutes intact. Whitespace before the offset is preserved.
	const normalized = value.replace(/(\s+)([+-])(\d{2})(\d{2})$/, "$1$2$3:$4");
	const time = Date.parse(normalized);
	return Number.isNaN(time) ? null : time;
}

// identity: { pid: <number>, timeMs: <epoch ms>, name: <string|null> } or null.
export function crashReportIdentity(path, read = readFileSync) {
	let text;
	try {
		text = read(path, "utf8");
	} catch {
		return null;
	}
	const limit = Math.min(text.length, 64 * 1024);
	if (path.endsWith(".ips")) {
		const firstBreak = text.indexOf("\n");
		if (firstBreak <= 0) return null;
		let metadata = null;
		try {
			metadata = JSON.parse(text.slice(0, firstBreak));
		} catch {
			return null;
		}
		const name = IPS_METADATA_KEYS.map((key) => metadata?.[key]).find((value) => typeof value === "string" && value) ?? null;
		const timeMs = parseTime(metadata?.timestamp);
		const bodyStart = text.indexOf("{", firstBreak);
		if (bodyStart < 0 || bodyStart > limit) return { pid: null, timeMs, name };
		let report = null;
		try {
			report = JSON.parse(text.slice(bodyStart));
		} catch {
			// Without a parsed PID, collection must skip the report.
			return { pid: null, timeMs, name };
		}
		return { pid: typeof report.pid === "number" ? report.pid : null, timeMs: parseTime(report.captureTime) ?? timeMs, name: report.procName ?? name };
	}
	if (path.endsWith(".crash")) {
		const head = text.slice(0, limit);
		const processLine = head.match(/^Process:\s+(.+?)\s*\[(\d+)\]/m);
		const dateLine = head.match(/^Date\/Time:\s+(.+)$/m);
		return {
			pid: processLine ? Number(processLine[2]) : null,
			name: processLine?.[1]?.trim() ?? null,
			timeMs: dateLine ? parseTime(dateLine[1].trim()) : null,
		};
	}
	return null;
}

// dirs: candidate report directories. criteria: { pid, sinceMs, untilMs }.
// A report matches only when both the parsed PID and the time window match.
// Matching reports carry their content so stack bytes survive cleanup of the
// isolated work directory and teardown of the runner.
export function collectMacosCrashReports(dirs, criteria, { read = readFileSync, list = readdirSync, contentLimit = REPORT_CONTENT_LIMIT, countLimit = REPORT_COUNT_LIMIT } = {}) {
	const reports = [];
	for (const dir of dirs) {
		let entries;
		try {
			entries = list(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (reports.length >= countLimit) break;
			if (!entry.isFile() || (!entry.name.endsWith(".ips") && !entry.name.endsWith(".crash"))) continue;
			const path = join(dir, entry.name);
			const identity = crashReportIdentity(path, read);
			if (!identity || identity.timeMs === null) continue;
			if (identity.timeMs < criteria.sinceMs || identity.timeMs > criteria.untilMs) continue;
			if (identity.pid !== criteria.pid) continue;
			let text;
			try {
				text = read(path, "utf8");
			} catch {
				continue;
			}
			const truncated = text.length > contentLimit;
			const headLength = Math.floor(contentLimit / 2);
			const content = truncated ? text.slice(0, headLength) + text.slice(-(contentLimit - headLength)) : text;
			reports.push({ file: basename(path), directory: dir, pid: identity.pid, name: identity.name, timeMs: identity.timeMs, bytes: Buffer.byteLength(text), truncated, content });
		}
	}
	return reports.sort((a, b) => a.timeMs - b.timeMs);
}
