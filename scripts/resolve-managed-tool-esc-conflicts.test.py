import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("resolve-managed-tool-esc-conflicts.py")

LOADER_CONFLICTS = '''<<<<<<< HEAD
\t\ton(event: string, handler: HandlerFn): () => void {
=======
\t\ton(event: string, handler: HandlerFn, options?: { uninterruptible?: boolean }): void {
>>>>>>> origin/patch/esc-abort
\t\t\tassertActive();
\t\t\tconst registeredHandler: HandlerFn = (...args) => handler(...args);
\t\t\tconst list = extension.handlers.get(event) ?? [];
<<<<<<< HEAD
\t\t\tlist.push(registeredHandler);
=======
\t\t\tif (event === "message_end" && options?.uninterruptible === true) {
\t\t\t\tconst terminalHandler: HandlerFn = (...args) => handler(...args);
\t\t\t\tlist.push(terminalHandler);
\t\t\t\textension.uninterruptibleHandlers?.add(terminalHandler);
\t\t\t} else {
\t\t\t\tlist.push(handler);
\t\t\t}
>>>>>>> origin/patch/esc-abort
\t\t\textension.handlers.set(event, list);

\t\t\treturn () => {
\t\t\t\tconst handlers = extension.handlers.get(event);
\t\t\t\tif (!handlers) return;
\t\t\t\tconst handlerIndex = handlers.indexOf(registeredHandler);
\t\t\t\tif (handlerIndex === -1) return;
\t\t\t\thandlers.splice(handlerIndex, 1);
\t\t\t\tif (handlers.length === 0) extension.handlers.delete(event);
\t\t\t};
\t\t},
'''

TYPES_CONFLICT = '''<<<<<<< HEAD
\t): () => void;
\ton(event: "before_provider_headers", handler: ExtensionHandler<BeforeProviderHeadersEvent>): () => void;
\ton(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): () => void;
=======
\t): void;
\ton(event: "before_provider_headers", handler: ExtensionHandler<BeforeProviderHeadersEvent>): void;
\ton(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
\ton(
\t\tevent: "message_end",
\t\thandler: (event: MessageEndEvent, ctx: ExtensionContext) => MessageEndEventResult | undefined,
\t\toptions: UninterruptibleMessageEndHandlerOptions,
\t): void;
>>>>>>> origin/patch/esc-abort
'''


def stage_unmerged(directory: Path, paths: list[str]) -> None:
    """Create real unmerged (stage 1/2/3) index entries for the given paths."""
    lines = []
    for rel in paths:
        content = (directory / rel).read_text()

        def blob(data: str) -> str:
            return subprocess.run(
                ["git", "hash-object", "-w", "--stdin"],
                input=data, capture_output=True, text=True, check=True, cwd=directory,
            ).stdout.strip()

        lines.append(f"100644 {blob('base:' + rel)} 1\t{rel}")
        lines.append(f"100644 {blob(content)} 2\t{rel}")
        lines.append(f"100644 {blob('theirs:' + rel)} 3\t{rel}")
    subprocess.run(
        ["git", "update-index", "--index-info"],
        input="\n".join(lines) + "\n",
        cwd=directory, check=True, capture_output=True, text=True,
    )


class EscResolverTests(unittest.TestCase):
    def run_with_conflicts(self, files: dict[str, str]):
        """Set up a scratch repo with the given conflict files and run the resolver."""
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            subprocess.run(["git", "init", "-q"], cwd=directory, check=True, capture_output=True)
            for rel, content in files.items():
                target = directory / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
            stage_unmerged(directory, list(files))
            result = subprocess.run(
                [sys.executable, str(SCRIPT)],
                cwd=directory, capture_output=True, text=True,
            )
            yield directory, result

    def test_resolves_loader_and_types_conflicts(self):
        loader_rel = "packages/coding-agent/src/core/extensions/loader.ts"
        types_rel = "packages/coding-agent/src/core/extensions/types.ts"
        for directory, result in self.run_with_conflicts(
            {loader_rel: LOADER_CONFLICTS, types_rel: TYPES_CONFLICT}
        ):
            self.assertEqual(result.returncode, 0, result.stderr)

            loader_out = (directory / loader_rel).read_text()
            self.assertIn(
                'on(event: string, handler: HandlerFn, options?: { uninterruptible?: boolean }): () => void {',
                loader_out,
            )
            self.assertIn("extension.uninterruptibleHandlers?.add(registeredHandler);", loader_out)
            self.assertIn(
                "list.push(registeredHandler);\n\t\t\textension.handlers.set(event, list);",
                loader_out,
            )
            self.assertNotIn("<<<<<<<", loader_out)

            types_out = (directory / types_rel).read_text()
            self.assertIn(
                'on(event: "before_provider_headers", handler: ExtensionHandler<BeforeProviderHeadersEvent>): () => void;',
                types_out,
            )
            self.assertIn("UninterruptibleMessageEndHandlerOptions,\n\t): void;", types_out)
            self.assertIn('on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): () => void;', types_out)
            self.assertNotIn("<<<<<<<", types_out)

    def test_rejects_unexpected_conflict_files(self):
        stray = "packages/some/other.ts"
        for directory, result in self.run_with_conflicts({stray: "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> z\n"}):
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unexpected managed-tool/Esc conflicts", result.stderr)


if __name__ == "__main__":
    unittest.main()
