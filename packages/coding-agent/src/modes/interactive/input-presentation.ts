import { parseSkillBlock } from "../../core/agent-session.ts";

/**
 * Command the user submitted for an expanded user message, or undefined when the text is not a
 * recoverable expansion. Uses only stored data: the recorded raw command, else a stored skill block.
 */
export function getSubmittedCommandText(text: string, rawInputText: string | undefined): string | undefined {
	if (rawInputText) return rawInputText;
	const skillBlock = parseSkillBlock(text);
	if (!skillBlock) return undefined;
	return skillBlock.userMessage ? `/skill:${skillBlock.name} ${skillBlock.userMessage}` : `/skill:${skillBlock.name}`;
}
