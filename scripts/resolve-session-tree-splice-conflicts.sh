#!/usr/bin/env bash
set -euo pipefail
expected=(packages/coding-agent/src/core/agent-session.ts packages/coding-agent/src/core/extensions/index.ts packages/coding-agent/src/core/session-manager.ts packages/coding-agent/test/suite/harness.ts)
mapfile -d '' -t conflicts < <(git diff --name-only --diff-filter=U -z)
if (( ${#conflicts[@]} != ${#expected[@]} )); then printf '::error::Unexpected session-tree splice conflicts:'; printf ' %q' "${conflicts[@]}"; printf '\n'; exit 1; fi
for index in "${!expected[@]}"; do if [[ ${conflicts[index]} != "${expected[index]}" ]]; then printf '::error::Unexpected session-tree splice conflicts:'; printf ' %q' "${conflicts[@]}"; printf '\n'; exit 1; fi; done
python - <<'PY'
from pathlib import Path
replacements={
'packages/coding-agent/src/core/agent-session.ts':('<<<<<<< HEAD\n\t\t\t\tappendEntry: (customType, data) => this.appendExtensionEntry(customType, data),\n=======\n\t\t\t\tappendEntry: (customType, data) => {\n\t\t\t\t\tconst entryId = this.sessionManager.appendCustomEntry(customType, data);\n\t\t\t\t\tconst entry = this.sessionManager.getEntry(entryId);\n\t\t\t\t\tif (entry) {\n\t\t\t\t\t\tthis._emit({ type: "entry_appended", entry });\n\t\t\t\t\t}\n\t\t\t\t},\n\t\t\t\tspliceEntry: (entryId) => {\n\t\t\t\t\tthis.spliceEntry(entryId);\n\t\t\t\t},\n>>>>>>> origin/patch/session-tree-splice\n','\t\t\t\tappendEntry: (customType, data) => this.appendExtensionEntry(customType, data),\n\t\t\t\tspliceEntry: (entryId) => {\n\t\t\t\t\tthis.spliceEntry(entryId);\n\t\t\t\t},\n'),
'packages/coding-agent/src/core/extensions/index.ts':('<<<<<<< HEAD\n\tSlowExtensionHookEntry,\n=======\n\tSpliceEntryHandler,\n>>>>>>> origin/patch/session-tree-splice\n','\tSlowExtensionHookEntry,\n\tSpliceEntryHandler,\n'),
'packages/coding-agent/src/core/session-manager.ts':('<<<<<<< HEAD\n\trmSync,\n=======\n>>>>>>> origin/patch/session-tree-splice\n\tstatSync,\n\tunlinkSync,\n','\trmSync,\n\tstatSync,\n\tunlinkSync,\n')}
for name,(old,new) in replacements.items():
 p=Path(name); s=p.read_text();
 if s.count(old)!=1: raise SystemExit(f'missing/ambiguous session-tree conflict: {name}')
 p.write_text(s.replace(old,new,1))
p=Path('packages/coding-agent/src/core/session-manager.ts'); s=p.read_text()
splice_anchor='\tspliceEntry(entryId: string): void {\n\t\tconst entry = this.byId.get(entryId);\n'
splice_replacement='\tspliceEntry(entryId: string): void {\n\t\tconst previousGeneration = this.generation;\n\t\tconst entry = this.byId.get(entryId);\n'
splice_publish='\t\tthis.fileEntries = nextEntries;\n\t\tthis._buildIndex();\n\t\tthis.leafId = nextLeafId;\n'
splice_publish_replacement='\t\tthis.fileEntries = nextEntries;\n\t\tthis._buildIndex();\n\t\tthis.leafId = nextLeafId;\n\t\tthis.generation = previousGeneration + 1;\n'
if s.count(splice_anchor)!=1 or s.count(splice_publish)!=1: raise SystemExit('session-tree generation splice anchors are missing or ambiguous')
p.write_text(s.replace(splice_anchor,splice_replacement,1).replace(splice_publish,splice_publish_replacement,1))
p=Path('packages/coding-agent/test/suite/harness.ts'); s=p.read_text()
a='<<<<<<< HEAD\n\tsessionManagerFactory?: (tempDir: string) => SessionManager;\n=======\n\tpersist?: boolean;\n>>>>>>> origin/patch/session-tree-splice\n'; b='\tsessionManagerFactory?: (tempDir: string) => SessionManager;\n\tpersist?: boolean;\n'
c='<<<<<<< HEAD\n\tconst sessionManager = options.sessionManagerFactory?.(tempDir) ?? SessionManager.inMemory();\n=======\n\tconst sessionManager = options.persist\n\t\t? SessionManager.create(tempDir, join(tempDir, "sessions"))\n\t\t: SessionManager.inMemory();\n>>>>>>> origin/patch/session-tree-splice\n'; d='\tconst sessionManager =\n\t\toptions.sessionManagerFactory?.(tempDir) ??\n\t\t(options.persist ? SessionManager.create(tempDir, join(tempDir, "sessions")) : SessionManager.inMemory());\n'
if s.count(a)!=1 or s.count(c)!=1: raise SystemExit('missing/ambiguous session-tree harness conflict')
p.write_text(s.replace(a,b,1).replace(c,d,1))
PY
git add "${expected[@]}"
test -z "$(git diff --name-only --diff-filter=U)"

python - <<'PY_GENERATION_TEST'
from pathlib import Path
path = Path("packages/coding-agent/test/session-manager/tree-traversal.test.ts")
text = path.read_text()
old = '''\t\tconst beforeMtime = statSync(sessionFile).mtimeMs;
\t\tawait new Promise((resolve) => setTimeout(resolve, 20));

\t\tsession.spliceEntry(id2);

\t\tconst entries = session.getEntries();
'''
new = '''\t\tconst beforeMtime = statSync(sessionFile).mtimeMs;
\t\tconst generationBeforeSplice = session.getGeneration();
\t\tawait new Promise((resolve) => setTimeout(resolve, 20));

\t\tsession.spliceEntry(id2);

\t\texpect(session.getGeneration()).toBeGreaterThan(generationBeforeSplice);
\t\tconst entries = session.getEntries();
'''
if text.count(old) != 1:
    raise SystemExit("session-tree splice generation test anchor is missing or ambiguous")
path.write_text(text.replace(old, new, 1))
PY_GENERATION_TEST
git add packages/coding-agent/test/session-manager/tree-traversal.test.ts

python - <<'PY_FIXTURE'
from pathlib import Path
path = Path("packages/coding-agent/test/lifecycle-diagnostics.test.ts")
text = path.read_text()
anchor = "\tappendEntry: () => {},\n"
line = "\tspliceEntry: () => {},\n"
if line not in text:
    if text.count(anchor) != 1:
        raise SystemExit("session-tree lifecycle fixture anchor is missing or ambiguous")
    path.write_text(text.replace(anchor, anchor + line, 1))
PY_FIXTURE
git add packages/coding-agent/test/lifecycle-diagnostics.test.ts

python - <<'PY_TEST'
from pathlib import Path
path = Path("packages/coding-agent/test/suite/session-tree-splice.test.ts")
text = path.read_text()
old = '''\t\texpect(\n\t\t\treopened.getEntries().map((entry) => (entry.type === "message" ? entry.message.role : entry.type)),\n\t\t).toEqual(["user"]);\n\t\texpect(reopened.getLeafId()).toBe(reopened.getEntries()[0]?.id);\n'''
new = '''\t\tconst reopenedEntries = reopened.getEntries();\n\t\texpect(reopenedEntries.filter((entry) => entry.type === "message").map((entry) => entry.message.role)).toEqual([\n\t\t\t"user",\n\t\t]);\n\t\texpect(reopened.getLeafId()).toBe(reopenedEntries.at(-1)?.id);\n'''
if text.count(old) != 1:
    raise SystemExit("session-tree persisted assertion anchor is missing or ambiguous")
path.write_text(text.replace(old, new, 1))
PY_TEST
git add packages/coding-agent/test/suite/session-tree-splice.test.ts
