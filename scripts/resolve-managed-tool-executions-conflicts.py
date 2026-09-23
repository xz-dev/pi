#!/usr/bin/env python3
"""Resolve managed-tool-executions compat-range doc conflicts onto upstream's
rewritten docs. The downstream tool_task/managed-execution feature has no
upstream equivalent, so re-append condensed sections instead of reverting."""
from pathlib import Path
import subprocess

expected = {
    Path("packages/coding-agent/README.md"),
    Path("packages/coding-agent/docs/settings.md"),
    Path("packages/coding-agent/docs/usage.md"),
}
conflicts = {
    Path(p)
    for p in subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], text=True
    ).splitlines()
}
if conflicts != expected:
    raise SystemExit(f"unexpected managed-tool-executions conflicts: {sorted(map(str, conflicts))}")

# settings.md: add backgroundToolCalls row + paragraph to the Tools section.
settings_path = Path("packages/coding-agent/docs/settings.md")
subprocess.run(["git", "checkout", "--ours", "--", str(settings_path)], check=True)
s = settings_path.read_text()
anchor = "| `defaultTools` | `string[]` | `read`, `bash`, `edit`, `write` | Built-in tools enabled at startup. An empty array disables all built-in tools but not extension or SDK tools. |"
addition = (
    anchor
    + "\n| `backgroundToolCalls` | object | `{}` | Per-tool managed background rules for third-party tools. An empty rule uses a 600-second detach threshold. |"
)
if s.count(anchor) != 1:
    raise SystemExit("unexpected settings.md defaultTools anchor")
s = s.replace(anchor, addition, 1)
para_anchor = "Available built-in tools are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`. CLI tool options override this setting for one invocation. See [Command Line](cli.md#tools)."
para = (
    para_anchor
    + "\n\n`tool_task` remains enabled with `defaultTools`, including an empty array. `--tools` is a strict allowlist for all tools, so include `tool_task` when managed execution controls are needed. `--no-tools` disables all tools; `--no-builtin-tools` disables the built-in defaults while retaining `tool_task` and extension/custom tools. `--exclude-tools` filters the resulting list.\n\n`backgroundToolCalls` opts named extension, SDK, or other third-party tools into managed execution. `{}` uses the default 600-second detach threshold; `detachAfterSeconds` must be a positive finite number. Invalid rule shapes or non-positive thresholds are diagnosed and not applied; reload keeps the last valid managed policy. Project rules merge with global rules by tool name. Unlisted third-party tools remain foreground-only. When no explicit `bash` or `powershell` rule exists, AI-called shell tools use the built-in 600-second detach policy when their `timeout` is omitted or strictly greater than 1200 seconds. Their original timeout continues after detach. User-entered `!` and `!!` shell commands are not managed. `tool_task` is never auto-backgrounded, and any `backgroundToolCalls.tool_task` rule is ignored."
)
if s.count(para_anchor) != 1:
    raise SystemExit("unexpected settings.md tools paragraph anchor")
s = s.replace(para_anchor, para, 1)
settings_path.write_text(s)
subprocess.run(["git", "add", str(settings_path)], check=True)

# usage.md: document managed tool executions after the follow-Pi's-work flow.
usage_path = Path("packages/coding-agent/docs/usage.md")
subprocess.run(["git", "checkout", "--ours", "--", str(usage_path)], check=True)
u = usage_path.read_text()
u_anchor = "## Change direction\n"
u_section = """## Managed tool executions

Long AI tool calls can detach from their original tool call according to `backgroundToolCalls` rules in [Settings](settings.md#tools). Detach returns one background-task result; underlying work continues under its original timeout.

The default `tool_task` tool provides:

- `list` and `info` to inspect managed executions
- `wait` to retrieve final output; `timeoutSeconds` is required and must be greater than 0 and no greater than 1800. Repeated waits return the cached outcome without re-executing the original tool
- `cancel` to request cancellation through the tool call's abort signal; this does not prove that an abort-ignoring operation stopped

Escape or another abort of the current agent run does not cancel an execution after it detaches; use `tool_task cancel` to request cancellation. `tool_task` itself is never auto-backgrounded, and a `backgroundToolCalls.tool_task` rule is ignored.

Completion notifications contain trusted task metadata only. Raw tool output is returned only by `tool_task wait`. Managed executions survive `/reload`; `/new`, `/resume`, `/fork`, session teardown, and process shutdown cancel and clear executions owned by the replaced session.

`tool_task` remains enabled when `defaultTools` omits normal built-ins. `--tools` is a strict allowlist, so include `tool_task` to retain management controls; `--no-tools` or `--exclude-tools tool_task` disables it. User-entered `!` and `!!` commands are separate from AI-called shell tools and never become managed executions.

"""
if u.count(u_anchor) != 1:
    raise SystemExit("unexpected usage.md section anchor")
u = u.replace(u_anchor, u_section + u_anchor, 1)
usage_path.write_text(u)
subprocess.run(["git", "add", str(usage_path)], check=True)

# README.md: upstream rewrote it (70 lines). The patch's two hunks were
# prose tweaks; upstream's new README covers model/tool mentions differently.
# Keep upstream's README wholesale — the feature is documented in usage.md.
readme_path = Path("packages/coding-agent/README.md")
subprocess.run(["git", "checkout", "--ours", "--", str(readme_path)], check=True)
subprocess.run(["git", "add", str(readme_path)], check=True)
