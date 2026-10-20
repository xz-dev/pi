import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { macOSOwnershipDiagnostics } from "../src/utils/process-ownership-diagnostics.ts";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const options = { offlineMode: false, quietStartup: false };

beforeEach(() => {
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});
afterEach(() => {
	Object.defineProperty(process, "platform", platform);
});

describe("macOS ownership startup hint", () => {
	it("is shown only on macOS, and never offline or with quiet startup", () => {
		expect(macOSOwnershipDiagnostics(options)).toEqual([]);
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		expect(macOSOwnershipDiagnostics(options)).toEqual([
			{ type: "info", message: expect.stringMatching(/best effort.*container/) },
		]);
		expect(macOSOwnershipDiagnostics({ offlineMode: true, quietStartup: false })).toEqual([]);
		expect(macOSOwnershipDiagnostics({ offlineMode: false, quietStartup: true })).toEqual([]);
		expect(macOSOwnershipDiagnostics({ offlineMode: false, quietStartup: "header" })).toHaveLength(1);
	});
});
