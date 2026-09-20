import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "resolver", Path(__file__).with_name("resolve-model-refresh-rebind-squash-conflicts.py")
)
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)

FIELD_CONFLICT = """<<<<<<< HEAD
\tprivate _cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;
=======
\tprivate _unsubscribeModelsChanged: () => void;
>>>>>>> origin/patch/model-refresh-session-rebind
"""

CTOR_CONFLICT = """<<<<<<< HEAD
\t\tthis._cacheWarmer = config.cacheWarmer;
\t\tif (this._cacheWarmer) {
\t\t\tthis._cacheWarmer.onWarmed = (entry) => this._emit({ type: "entry_appended", entry });
\t\t}
=======
\t\tthis._unsubscribeModelsChanged = this._modelRuntime.onModelsChanged(() => this._refreshModelsFromRuntime());
>>>>>>> origin/patch/model-refresh-session-rebind
"""

SURROUNDING = (
    "export class AgentSession {\n"
    + FIELD_CONFLICT
    + "\tprivate _toolRegistry: Map<string, AgentTool> = new Map();\n"
    + "\n"
    + "\tconstructor(config: AgentSessionConfig) {\n"
    + CTOR_CONFLICT
    + "\t\tthis._extensionRunnerRef = config.extensionRunnerRef;\n"
    + "\t}\n"
    + "}\n"
)


class RebindResolverTest(unittest.TestCase):
    def test_unions_both_conflict_hunks(self):
        text = SURROUNDING
        for ours, theirs, resolution in resolver.HUNKS:
            text = resolver.resolve_conflict(text, ours, theirs, resolution, "agent-session")
        self.assertIn('private _cacheWarmer?: Pick<CacheWarmer, "cancel"', text)
        self.assertIn("private _unsubscribeModelsChanged: () => void;", text)
        self.assertIn(
            "this._unsubscribeModelsChanged = this._modelRuntime.onModelsChanged(() => this._refreshModelsFromRuntime());",
            text,
        )
        self.assertNotIn("<<<<<<<", text)
        self.assertNotIn(">>>>>>>", text)

    def test_rejects_unexpected_shape(self):
        bad = SURROUNDING.replace(
            "\tprivate _unsubscribeModelsChanged: () => void;",
            "\tprivate _unsubscribeModelsChanged: () => void; // mutated",
        )
        with self.assertRaises(SystemExit):
            resolver.resolve_conflict(
                bad,
                resolver.HUNKS[0][0],
                resolver.HUNKS[0][1],
                resolver.HUNKS[0][2],
                "agent-session",
            )


if __name__ == "__main__":
    unittest.main()
