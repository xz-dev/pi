import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import type { MessageOrigin } from "@earendil-works/pi-ai";
import { isSyntheticPath, type SourceInfo } from "../source-info.ts";

/** Bound at the extension boundary, including asynchronous calls made by its retained API. */
export function getExtensionOrigin(source: SourceInfo): MessageOrigin {
	const file = basename(source.path).replace(/\.(?:ts|js|mts|mjs)$/, "");
	const name = isSyntheticPath(source.path)
		? source.path.replace(/[<>]/g, "")
		: source.origin === "package"
			? basename(source.baseDir ?? dirname(source.path))
			: file === "index"
				? basename(dirname(source.path))
				: file;
	return {
		type: "extension",
		extensionId: createHash("sha256").update(source.path).digest("hex").slice(0, 16),
		extensionName: name,
	};
}
