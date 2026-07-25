import type { AgentMessage } from "@earendil-works/pi-agent-core";

function messagesHaveSameStableIdentity(left: AgentMessage, right: AgentMessage): boolean {
	if (left === right) return true;
	if (left.role !== right.role || left.timestamp !== right.timestamp) return false;
	return JSON.stringify(left) === JSON.stringify(right);
}

function findLiveSuffix(
	persistedMessages: AgentMessage[],
	currentMessages: AgentMessage[],
): AgentMessage[] | undefined {
	const persisted = [...persistedMessages];
	const persistedTail = persisted.at(-1);
	if (
		persistedTail?.role === "assistant" &&
		persistedTail.stopReason === "error" &&
		!currentMessages.some((message) => message.role === "assistant" && message.timestamp === persistedTail.timestamp)
	) {
		persisted.pop();
	}
	let frontier = -1;
	let searchFrom = 0;
	for (const persistedMessage of persisted) {
		let match = -1;
		for (let index = searchFrom; index < currentMessages.length; index++) {
			if (messagesHaveSameStableIdentity(persistedMessage, currentMessages[index])) {
				match = index;
				break;
			}
		}
		if (match < 0) return undefined;
		frontier = match;
		searchFrom = match + 1;
	}
	return currentMessages.slice(frontier + 1);
}

export interface CheckpointProjectionMerge {
	portableMessages: AgentMessage[];
	activeMessages: AgentMessage[];
	applied: boolean;
}

/** Merge rebuilt persisted projections with messages that exist only in the live agent loop. */
export function mergeCheckpointProjectionWithLiveSuffix(
	persistedMessagesBefore: AgentMessage[],
	portableMessagesAfter: AgentMessage[],
	checkpointMessagesAfter: AgentMessage[],
	currentMessagesBefore: AgentMessage[],
): CheckpointProjectionMerge {
	if (currentMessagesBefore.length === 0 && checkpointMessagesAfter.length > 0) {
		return {
			portableMessages: [...portableMessagesAfter],
			activeMessages: [...checkpointMessagesAfter],
			applied: true,
		};
	}
	const liveSuffix = findLiveSuffix(persistedMessagesBefore, currentMessagesBefore);
	if (!liveSuffix) {
		return {
			portableMessages: currentMessagesBefore,
			activeMessages: currentMessagesBefore,
			applied: false,
		};
	}
	return {
		portableMessages: [...portableMessagesAfter, ...liveSuffix],
		activeMessages: [...checkpointMessagesAfter, ...liveSuffix],
		applied: true,
	};
}
