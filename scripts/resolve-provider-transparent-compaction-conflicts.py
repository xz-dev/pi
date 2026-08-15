#!/usr/bin/env python3
from pathlib import Path
import subprocess

expected = {
    Path("packages/coding-agent/src/core/agent-session.ts"),
    Path("packages/coding-agent/src/core/session-manager.ts"),
    Path("packages/coding-agent/src/core/settings-manager.ts"),
}
conflicts = {
    Path(path)
    for path in subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
}
if conflicts != expected:
    raise SystemExit(f"unexpected conflicts: {sorted(map(str, conflicts))}")


def conflict_blocks(text: str) -> list[tuple[int, int, str, str]]:
    lines = text.splitlines(keepends=True)
    blocks: list[tuple[int, int, str, str]] = []
    index = 0
    while index < len(lines):
        if not lines[index].startswith("<<<<<<<"):
            index += 1
            continue
        start = index
        index += 1
        ours: list[str] = []
        while index < len(lines) and not lines[index].startswith(("|||||||", "=======")):
            ours.append(lines[index])
            index += 1
        if index < len(lines) and lines[index].startswith("|||||||"):
            index += 1
            while index < len(lines) and not lines[index].startswith("======="):
                index += 1
        if index >= len(lines) or not lines[index].startswith("======="):
            raise SystemExit("malformed provider-compaction conflict block")
        index += 1
        theirs: list[str] = []
        while index < len(lines) and not lines[index].startswith(">>>>>>>"):
            theirs.append(lines[index])
            index += 1
        if index >= len(lines):
            raise SystemExit("unterminated provider-compaction conflict block")
        blocks.append((start, index + 1, "".join(ours), "".join(theirs)))
        index += 1
    return blocks


def resolve(path: Path, expected_pairs: list[tuple[str, str]], replacements: list[str]) -> None:
    text = path.read_text()
    lines = text.splitlines(keepends=True)
    blocks = conflict_blocks(text)
    if [(ours, theirs) for _, _, ours, theirs in blocks] != expected_pairs:
        raise SystemExit(f"unexpected provider-compaction conflict shape: {path}")
    for (start, end, _, _), replacement in reversed(list(zip(blocks, replacements, strict=True))):
        lines[start:end] = [replacement]
    resolved = "".join(lines)
    if any(line.startswith(("<<<<<<<", "|||||||", "=======", ">>>>>>>")) for line in resolved.splitlines()):
        raise SystemExit(f"provider-compaction conflict marker remains: {path}")
    path.write_text(resolved)


agent_pairs = [
    (
        'import { contentText, type Message } from "@earendil-works/pi-ai";\n',
        'import { contentText } from "@earendil-works/pi-ai";\n'
        'import {\n'
        '\tcompactAzureOpenAIResponses,\n'
        '\tgetAzureOpenAIResponsesCompactionIdentity,\n'
        '} from "@earendil-works/pi-ai/api/azure-openai-responses";\n'
        'import {\n'
        '\tcompactOpenAICodexResponses,\n'
        '\tgetOpenAICodexResponsesCompactionIdentity,\n'
        '} from "@earendil-works/pi-ai/api/openai-codex-responses";\n'
        'import {\n'
        '\tcompactOpenAIResponses,\n'
        '\tgetOpenAIResponsesCompactionIdentity,\n'
        '\ttype OpenAIResponsesCompaction,\n'
        '\ttype ResponsesCompactionIdentity,\n'
        '} from "@earendil-works/pi-ai/api/openai-responses";\n',
    ),
    (
        'import { planContinuation } from "./manual-retry.ts";\n'
        'import type { BashExecutionMessage, CustomMessage, ManualRetryRecoveryMessage } from "./messages.ts";\n',
        'import { type BashExecutionMessage, type CustomMessage, convertToLlm } from "./messages.ts";\n',
    ),
    (
        '\tprivate _unsubscribeModelsChanged: () => void;\n',
        '\tprivate _classicRecoveryStreamFn?: StreamFn;\n'
        '\tprivate _prepareRequestHeaders?: AgentSessionConfig["prepareRequestHeaders"];\n',
    ),
    (
        '\t\tthis._unsubscribeModelsChanged = this._modelRuntime.onModelsChanged(() => this._refreshModelsFromRuntime());\n',
        '\t\tthis._classicRecoveryStreamFn = config.classicRecoveryStreamFn;\n'
        '\t\tthis._prepareRequestHeaders = config.prepareRequestHeaders;\n',
    ),
]
agent_replacements = [
    agent_pairs[0][0] + agent_pairs[0][1].split("\n", 1)[1],
    'import { planContinuation } from "./manual-retry.ts";\n'
    'import {\n'
    '\ttype BashExecutionMessage,\n'
    '\ttype CustomMessage,\n'
    '\tconvertToLlm,\n'
    '\ttype ManualRetryRecoveryMessage,\n'
    '} from "./messages.ts";\n',
    agent_pairs[2][0] + agent_pairs[2][1],
    agent_pairs[3][0] + agent_pairs[3][1],
]
resolve(Path("packages/coding-agent/src/core/agent-session.ts"), agent_pairs, agent_replacements)

continuation_type = '''export interface ContinuationCommit {
\texpectedSessionId: string;
\texpectedLeafId: string | null;
\texpectedGeneration: number;
\tbranchFromId: string | null;
\tmessages: Message[];
}

export type ContinuationFileWriter = (temporaryFile: string, destinationFile: string, contents: Buffer) => void;

const writeContinuationFile: ContinuationFileWriter = (temporaryFile, destinationFile, contents) => {
\tconst mode = existsSync(destinationFile) ? statSync(destinationFile).mode & 0o777 : 0o600;
\tconst fileDescriptor = openSync(temporaryFile, "wx", mode);
\ttry {
\t\twriteFileSync(fileDescriptor, contents);
\t\tfsyncSync(fileDescriptor);
\t} finally {
\t\tcloseSync(fileDescriptor);
\t}
\t// Atomic replacement requires source and destination to share a directory.
\trenameSync(temporaryFile, destinationFile);
\tif (process.platform !== "win32") {
\t\tlet directoryDescriptor: number | undefined;
\t\ttry {
\t\t\tdirectoryDescriptor = openSync(dirname(destinationFile), "r");
\t\t\tfsyncSync(directoryDescriptor);
\t\t} catch {
\t\t\t// Some filesystems do not support directory fsync. The atomic rename
\t\t\t// has already succeeded, so this durability reinforcement is best-effort.
\t\t} finally {
\t\t\tif (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
\t\t}
\t}
};

'''
compaction_type = '''export interface CompactionCommitExpectation {
\tsessionId: string;
\tgeneration: number;
\tleafId: string | null;
\tsourceEntries?: string;
\trawSourceEntries?: string;
\tdependencies?: {
\t\tmodel: { provider: string; modelId: string } | null;
\t\tthinkingLevel: string;
\t};
}

'''
continuation_writer = '''\t/** @internal Fault-injection seam for continuation publication tests. */
\tcontinuationFileWriter: ContinuationFileWriter = writeContinuationFile;
'''
persistence_ops = '''\tprivate persistenceOps = {
\t\tappendFileSync,
\t\tcloseSync,
\t\topenSync,
\t\trmSync,
\t\twriteFileSync,
\t};
'''
append_ours = '''\t\tthis.byId.set(entry.id, entry);
\t\tthis.leafId = entry.id;
\t\tthis.generation++;
\t\tthis._persist(entry);
'''
append_theirs = '''\t\tthis.byId.set(publicEntry.id, publicEntry);
\t\tthis.leafId = publicEntry.id;
\t\tthis.generation++;
\t\tthis.flushed = nextFlushed;
\t}

\tgetGeneration(): number {
\t\treturn this.generation;
\t}

\tcaptureCompactionCommitExpectation(options?: { branch?: SessionEntry[] }): CompactionCommitExpectation {
\t\tconst branch = options?.branch ?? this.getBranch();
\t\tconst settings = options ? getSessionContextSettings(branch) : undefined;
\t\treturn {
\t\t\tsessionId: this.sessionId,
\t\t\tgeneration: this.generation,
\t\t\tleafId: this.leafId,
\t\t\tsourceEntries: options ? compactionDependencySnapshot(branch) : undefined,
\t\t\trawSourceEntries: options ? JSON.stringify(branch) : undefined,
\t\t\tdependencies:
\t\t\t\toptions && settings
\t\t\t\t\t? {
\t\t\t\t\t\t\tmodel: settings.model,
\t\t\t\t\t\t\tthinkingLevel: settings.thinkingLevel,
\t\t\t\t\t\t}
\t\t\t\t\t: undefined,
\t\t};
'''
session_pairs = [
    (continuation_type, compaction_type),
    (continuation_writer, persistence_ops),
    (append_ours, append_theirs),
]
session_replacements = [
    continuation_type + compaction_type,
    continuation_writer + persistence_ops,
    append_theirs,
]
manager_path = Path("packages/coding-agent/src/core/session-manager.ts")
resolve(manager_path, session_pairs, session_replacements)
manager = manager_path.read_text()
generation_method = '''\tgetGeneration(): number {
\t\treturn this.generation;
\t}

'''
if manager.count(generation_method) != 2:
    raise SystemExit("expected exactly two getGeneration methods before provider-compaction deduplication")
manager = manager.replace(generation_method, "", 1)
generation_anchor = '''\tcreateBranchedSession(leafId: string): string | undefined {
\t\tconst previousSessionFile = this.sessionFile;
'''
generation_replacement = '''\tcreateBranchedSession(leafId: string): string | undefined {
\t\tconst previousGeneration = this.generation;
\t\tconst previousSessionFile = this.sessionFile;
'''
persisted_scope = '''\t\t\tthis.sessionFile = newSessionFile;
\t\t\tthis._buildIndex();
\t\t\tthis.generation++;
'''
persisted_replacement = '''\t\t\tthis.sessionFile = newSessionFile;
\t\t\tthis._buildIndex();
\t\t\tthis.generation = previousGeneration + 1;
'''
memory_scope = '''\t\tthis.sessionId = newSessionId;
\t\tthis._buildIndex();
\t\tthis.generation++;
\t\treturn undefined;
'''
memory_replacement = '''\t\tthis.sessionId = newSessionId;
\t\tthis._buildIndex();
\t\tthis.generation = previousGeneration + 1;
\t\treturn undefined;
'''
if manager.count(generation_anchor) != 1:
    raise SystemExit("createBranchedSession generation anchor is missing or ambiguous")
if manager.count(persisted_scope) != 1 or manager.count(memory_scope) != 1:
    raise SystemExit("createBranchedSession generation scopes are missing or ambiguous")
manager = manager.replace(generation_anchor, generation_replacement, 1)
manager = manager.replace(persisted_scope, persisted_replacement, 1)
manager = manager.replace(memory_scope, memory_replacement, 1)
manager_path.write_text(manager)

settings_ours = '''\t\tnonRetryableErrorPatterns?: string[];
\t} {
\t\tconst nonRetryableErrorPatterns = normalizeNonRetryableErrorPatterns(
\t\t\tthis.settings.retry?.nonRetryableErrorPatterns,
\t\t);
'''
settings_theirs = '''\t} {
'''
resolve(
    Path("packages/coding-agent/src/core/settings-manager.ts"),
    [(settings_ours, settings_theirs)],
    [settings_ours],
)

subprocess.run(["git", "add", *map(str, sorted(expected))], check=True)
