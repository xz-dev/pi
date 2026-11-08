import type { MessageOrigin } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { prepareBranchEntries } from "../src/core/compaction/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

// #11602: custom-message edits must preserve provenance and omit hidden content.
it("preserves custom-message origins through branch-summary replacement and omission", () => {
	const origin: MessageOrigin = { type: "extension", extensionId: "test.origin", extensionName: "Origin" };
	const ids = ["ordinary", "replaced", "omitted"];
	const branch: SessionEntry[] = ids.map(
		(id, index): SessionEntry => ({
			type: "custom_message",
			id,
			parentId: index === 0 ? null : ids[index - 1],
			timestamp: new Date(index + 1).toISOString(),
			customType: "notice",
			content: id,
			display: false,
			origin,
		}),
	);
	branch.push(
		{
			type: "context_edit",
			id: "replacement",
			parentId: "omitted",
			timestamp: new Date(4).toISOString(),
			targetId: "replaced",
			replacement: { content: "edited" },
		},
		{
			type: "context_edit",
			id: "omission",
			parentId: "replacement",
			timestamp: new Date(5).toISOString(),
			targetId: "omitted",
			replacement: null,
		},
	);

	expect(prepareBranchEntries(branch).messages).toMatchObject([
		{ role: "custom", content: "ordinary", origin },
		{ role: "custom", content: "edited", origin },
	]);
	expect(branch[1]).toMatchObject({ content: "replaced", origin });
});
