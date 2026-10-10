import { afterEach, expect, it, vi } from "vitest";
import { formatFatalError, runMain } from "../src/cli-entry.ts";

const originalExitCode = process.exitCode;

afterEach(() => {
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
});

it("formats stackless DOM exceptions without dumping legacy constants", () => {
	const error = new DOMException("The operation timed out.", "TimeoutError");
	error.stack = "";
	expect(formatFatalError(error)).toBe("TimeoutError: The operation timed out.");
});

it("preserves DOM exception stacks when available", () => {
	const error = new DOMException("cancelled", "AbortError");
	error.stack = "AbortError: cancelled\n    at entry.ts:1:1";
	expect(formatFatalError(error)).toBe(error.stack);
});

it("preserves ordinary error stacks", () => {
	const error = new Error("failed");
	error.stack = "Error: failed\n    at entry.ts:1:1";
	expect(formatFatalError(error)).toBe(error.stack);
});

it("reports a rejected CLI main once and sets exit status 1", async () => {
	const error = new DOMException("The operation timed out.", "TimeoutError");
	error.stack = "";
	const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

	await runMain(() => Promise.reject(error));

	expect(consoleSpy).toHaveBeenCalledOnce();
	expect(consoleSpy).toHaveBeenCalledWith("TimeoutError: The operation timed out.");
	expect(process.exitCode).toBe(1);
});
