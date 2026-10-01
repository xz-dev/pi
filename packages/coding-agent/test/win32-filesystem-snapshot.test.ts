import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	getWindowsFilesystemSnapshotRelativePath,
	loadWindowsFilesystemSnapshotHelper,
	snapshotWindowsDirectory,
	snapshotWindowsRegularFile,
} from "../src/utils/win32-filesystem-snapshot.ts";

describe("Windows filesystem snapshot helper loader", () => {
	it("uses architecture-specific updater-owned artifact paths", () => {
		expect(getWindowsFilesystemSnapshotRelativePath("x64")).toBe(
			join("native", "win32", "prebuilds", "win32-x64", "pi-filesystem-snapshot.node"),
		);
		expect(getWindowsFilesystemSnapshotRelativePath("arm64")).toBe(
			join("native", "win32", "prebuilds", "win32-arm64", "pi-filesystem-snapshot.node"),
		);
		expect(() => getWindowsFilesystemSnapshotRelativePath("ia32")).toThrow(
			"Unsupported Windows filesystem snapshot architecture: ia32",
		);
	});

	it("loads the first existing valid helper", () => {
		const helper = {
			apiVersion: 1,
			snapshotDirectory: vi.fn(),
			snapshotRegularFile: vi.fn(),
		};
		const loadModule = vi.fn((path: string) => {
			if (path !== "second.node") throw new Error(`Unexpected load ${path}`);
			return helper;
		});

		expect(
			loadWindowsFilesystemSnapshotHelper({
				arch: "x64",
				candidates: ["missing.node", "second.node"],
				exists: (path) => path === "second.node",
				loadModule,
			}),
		).toBe(helper);
		expect(loadModule).toHaveBeenCalledOnce();
	});

	it("fails closed when the first existing helper cannot load", () => {
		const loadModule = vi.fn(() => {
			throw new Error("invalid DLL");
		});

		expect(() =>
			loadWindowsFilesystemSnapshotHelper({
				arch: "arm64",
				candidates: ["corrupt.node", "fallback.node"],
				exists: () => true,
				loadModule,
			}),
		).toThrow("Could not load Pi Windows filesystem snapshot helper at corrupt.node: invalid DLL");
		expect(loadModule).toHaveBeenCalledOnce();
	});

	it("validates native snapshot results before exposing them", () => {
		const directory = {
			canonicalPath: "C:\\pi\\bundles",
			identity: "0123456789abcdef:00112233445566778899aabbccddeeff",
		};
		const contents = Buffer.from("current\n");
		const helper = {
			apiVersion: 1 as const,
			snapshotDirectory: vi.fn(() => directory),
			snapshotRegularFile: vi.fn(() => ({ ...directory, size: contents.length, contents })),
		};

		expect(snapshotWindowsDirectory("C:\\pi\\bundles", helper)).toEqual(directory);
		expect(snapshotWindowsRegularFile("C:\\pi\\current", 256, true, helper)).toEqual({
			...directory,
			size: contents.length,
			contents,
		});
		expect(helper.snapshotRegularFile).toHaveBeenCalledWith("C:\\pi\\current", 256, true);
	});

	it("rejects malformed native snapshot results", () => {
		const helper = {
			apiVersion: 1 as const,
			snapshotDirectory: () => ({ canonicalPath: "", identity: "bad" }),
			snapshotRegularFile: () => ({
				canonicalPath: "C:\\pi\\current",
				identity: "0123456789abcdef:00112233445566778899aabbccddeeff",
				size: 8,
				contents: Buffer.from("short"),
			}),
		};

		expect(() => snapshotWindowsDirectory("C:\\pi\\bundles", helper)).toThrow(
			"Pi Windows filesystem snapshot helper returned an invalid directory snapshot",
		);
		expect(() => snapshotWindowsRegularFile("C:\\pi\\current", 256, true, helper)).toThrow(
			"Pi Windows filesystem snapshot helper returned an invalid regular-file snapshot",
		);
	});

	it("fails closed for a malformed or missing helper", () => {
		expect(() =>
			loadWindowsFilesystemSnapshotHelper({
				arch: "x64",
				candidates: ["malformed.node"],
				exists: () => true,
				loadModule: () => ({ apiVersion: 1, snapshotDirectory: () => ({}) }),
			}),
		).toThrow("Pi Windows filesystem snapshot helper at malformed.node has an invalid API");

		expect(() =>
			loadWindowsFilesystemSnapshotHelper({
				arch: "x64",
				candidates: ["missing.node"],
				exists: () => false,
				loadModule: () => {
					throw new Error("must not load");
				},
			}),
		).toThrow("Pi Windows filesystem snapshot helper is missing");
	});
});
