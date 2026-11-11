import { createRequire } from "node:module";

export interface WindowsOwnershipHelper {
	/** Native parent snapshot plus a live query/synchronize handle, closed before return. */
	ownershipParentIdentity(): { pid: number; creationTime: string };
	/** Validate the inherited read pipe and clear HANDLE_FLAG_INHERIT before tools can start. */
	prepareOwnershipPipe(handle: string): void;
	/** Undefined means no available data; null is actual pipe EOF. */
	readOwnershipPipe(handle: string): Uint8Array | null | undefined;
	closeOwnershipPipe(handle: string): void;
}

export function loadWindowsOwnershipHelper(path: string): WindowsOwnershipHelper {
	const helper = createRequire(path)(path) as Partial<WindowsOwnershipHelper> | null;
	if (
		typeof helper?.ownershipParentIdentity !== "function" ||
		typeof helper.prepareOwnershipPipe !== "function" ||
		typeof helper.readOwnershipPipe !== "function" ||
		typeof helper.closeOwnershipPipe !== "function"
	) {
		throw new Error("pi: Windows ownership support is missing; rebuild or reinstall the native platform helper");
	}
	return helper as WindowsOwnershipHelper;
}
