# Message Types

Pi uses `AgentMessage` values in SDK state, lifecycle events, RPC responses, and persisted session message entries. This page defines those shared messages and their content blocks.

Message timestamps are Unix timestamps in milliseconds. They are different from the ISO 8601 timestamps on [session entries](session-format.md#entry-base).

Source definitions:

- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts) defines provider-facing messages and content blocks.
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts) defines the extensible `AgentMessage` union.
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/messages.ts) adds coding-agent message roles.

## Content blocks

### TextContent

```typescript
interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}
```

`textSignature` contains provider-specific message metadata. Treat it as opaque.

### ImageContent

```typescript
interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
```

`data` is base64-encoded image data. `mimeType` identifies its media type, such as `image/png` or `image/jpeg`.

### ThinkingContent

```typescript
interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}
```

Thinking signatures contain provider-specific replay data. Treat them as opaque. A redacted block can have no visible thinking text while retaining an encrypted payload in `thinkingSignature`.

### ToolCall

```typescript
interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string;
  namespace?: string;
}
```

`thoughtSignature` is provider-specific. `namespace` identifies an OpenAI Responses namespace for dynamically loaded or namespaced tools.

## Usage

Assistant messages always contain usage. Tool results can contain usage when the tool performed nested model work.

```typescript
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

When present, `reasoning` is already included in `output`; do not add it again. `cacheWrite1h` is the subset of `cacheWrite` written with one-hour retention.

## Base messages

### SystemMessage

```typescript
interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: ToolReference[];
  timestamp: number;
}
```

The leading system message declares the initial prompt and tools. Later system messages can append instructions, replace or remove named prompt sections, and add or remove tools. Replaying them in order yields the current state.

### UserMessage

```typescript
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  origin?: MessageOrigin;
  timestamp: number;
}
```

### MessageOrigin

```typescript
type MessageOrigin =
  | { type: "interactive" }
  | { type: "extension"; extensionId: string; extensionName?: string }
  | { type: "rpc" }
  | { type: "sdk" }
  | { type: "cli" };
```

`origin` records the input boundary, independently of the provider role. Pi stamps terminal submissions as `interactive`, command-line prompts as `cli`, RPC submissions as `rpc`, and direct SDK calls as `sdk` by default. Its extension wrappers stamp `extension` automatically. `extensionId` is an opaque identifier derived from the loaded entry path; it is stable while that path is unchanged, not a portable identity or authentication credential. `extensionName` is for display.

An absent origin means **unrecorded**, not human-authored. Pi does not guess from the content of old messages. Terminal input includes indistinguishable simulated keystrokes. In-process extensions remain trusted code; this is not a sandbox or permission boundary.

Non-interactive user/custom input gets a deterministic source note in model context and summarization. The raw stored content is unchanged. The note does not elevate the protocol role or grant user authorization. Empty control messages remain empty, and image-only input retains its image blocks.

### AssistantMessage

```typescript
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  providerThinkingLevel?: string;
  thinkingLevel?: ModelThinkingLevel;
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  deferred?: DeferredHandle;
  errorMessage?: string;
  rawStopReason?: string;
  endTurn?: boolean;
  timestamp: number;
}
```

`responseModel` records a concrete provider response model when it differs from the requested model. `responseId`, `providerThinkingLevel`, `thinkingLevel`, `diagnostics`, and `rawStopReason` preserve provider or runtime details.

`"pending"` is used for a partial assistant message while it streams. The completed message in `message_end` has a terminal stop reason, and Pi does not persist `"pending"` assistant messages in session JSONL.

A `"deferred"` response has a `DeferredHandle` with the provider data needed to retrieve it:

```typescript
interface DeferredHandle {
  provider: string;
  modelId: string;
  api: string;
  id: string;
  expiresAt?: number;
  pollAfterMs?: number;
  data?: JsonValue;
}
```

### ToolResultMessage

```typescript
interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  usage?: Usage;
  nestedCalls?: NestedToolCalls;
  isError: boolean;
  timestamp: number;
}
```

`details` is tool-specific. Optional `usage` reports nested model work performed by the tool and contributes to full-session statistics, but it is not part of the main model-call usage. `nestedCalls` records bounded metadata about calls this tool made to other tools:

```typescript
interface NestedToolCalls {
  calls: NestedToolCallRecord[];
  complete: boolean;
}

interface NestedToolCallRecord {
  id: string;
  name: string;
  arguments?: JsonObject;
  argumentsBytes?: number;
  status: "ok" | "error" | "unfinished";
  durationMs?: number;
  error?: string;
}
```

## Coding-agent messages

The coding-agent package extends `AgentMessage` with four roles.

### BashExecutionMessage

Created by direct shell commands, including the RPC [`bash`](rpc-commands.md#bash) command. It is not an LLM tool result.

```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp: number;
}
```

Unless `excludeFromContext` is true, Pi converts this message to user-role text before the next model request.

### CustomMessage

Created when an extension sends a context message.

```typescript
interface CustomMessage<T = unknown> {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: T;
  origin?: MessageOrigin;
  timestamp: number;
}
```

Pi converts its content to a user message for model requests, adding a source note when recorded. `details` is not sent to the model. Nonempty `display: false` context has a visible source heading in the TUI, with its body initially folded. Empty control markers stay invisible. Clicking the heading in fullscreen mode toggles one body; the configurable global tool-expansion action (default `Ctrl+O`) applies to these messages too. The source heading and body use gray text on the tool-execution background, without expansion hints or added italics.

### BranchSummaryMessage

```typescript
interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string | null;
  timestamp: number;
}
```

Pi creates this context message from a persisted `branch_summary` entry.

### CompactionSummaryMessage

```typescript
interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

Pi creates this context message from a persisted `compaction` entry.

## AgentMessage union

In the coding agent, the union is equivalent to:

```typescript
type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;
```

At the lower-level agent package, `AgentMessage` is `Message | CustomAgentMessages[keyof CustomAgentMessages]`. Applications can add roles through TypeScript declaration merging, so consumers should tolerate unknown custom roles when they accept messages from an augmented host.
