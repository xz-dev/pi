import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";

export type PublicTextContent = Omit<TextContent, "textSignature">;
export type PublicThinkingContent = Omit<ThinkingContent, "thinkingSignature">;
export type PublicToolCall = Omit<ToolCall, "thoughtSignature">;
export type PublicAssistantContent = PublicTextContent | PublicThinkingContent | PublicToolCall;

export interface PublicAssistantMessage
	extends Omit<
		AssistantMessage,
		"api" | "provider" | "model" | "responseModel" | "responseId" | "diagnostics" | "content"
	> {
	content: PublicAssistantContent[];
}

export type PublicMessage = Exclude<Message, AssistantMessage> | PublicAssistantMessage;
export type PublicAgentMessage = Exclude<AgentMessage, AssistantMessage> | PublicAssistantMessage;

function sanitizeAssistantContent(content: AssistantMessage["content"]): PublicAssistantContent[] {
	return content.map((block) => {
		switch (block.type) {
			case "text": {
				const { textSignature: _, ...visible } = structuredClone(block);
				return visible;
			}
			case "thinking": {
				const { thinkingSignature: _, ...visible } = structuredClone(block);
				return visible;
			}
			case "toolCall": {
				const { thoughtSignature: _, ...visible } = structuredClone(block);
				return visible;
			}
			default:
				return block satisfies never;
		}
	});
}

function toPublicAssistantMessage(message: AssistantMessage): PublicAssistantMessage {
	const {
		api: _,
		provider: __,
		model: ___,
		responseModel: ____,
		responseId: _____,
		diagnostics: ______,
		content,
		...visible
	} = structuredClone(message);
	return { ...visible, content: sanitizeAssistantContent(content) };
}

export function toPublicAgentMessage(message: AgentMessage): PublicAgentMessage {
	if (message.role !== "assistant") return structuredClone(message);
	return toPublicAssistantMessage(message);
}

export function toPublicMessage(message: Message): PublicMessage {
	if (message.role !== "assistant") return structuredClone(message);
	return toPublicAssistantMessage(message);
}
