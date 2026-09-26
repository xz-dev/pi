# Pi Packages

Pi packages install and distribute extensions, skills, prompt templates, and themes as one unit. Use a package when a customization should be shared through npm or git, or when several resources belong together.

A package is an ordinary directory or npm package. It can expose conventional resource directories, declare explicit paths under the `pi` key in `package.json`, and carry its own runtime dependencies.

## Install and manage packages

Install from npm, git, or a local path:

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install https://github.com/user/repo  # raw URLs work too
pi install /absolute/path/to/package
pi install ./relative/path/to/package

pi remove npm:@foo/bar
pi list                     # show installed packages from settings
pi update                   # update pi only
pi update --all             # update pi, update packages, and reconcile pinned git refs
pi update --extensions      # update packages and reconcile pinned git refs only
pi update --models          # refresh Pi-managed catalogs without loading extensions
pi update --self            # update pi only
pi update --self --force    # reinstall pi even if current
pi update npm:@foo/bar      # update one package
pi update --extension npm:@foo/bar
```

`pi list` shows configured packages. Use `pi remove <source>` to remove one and `pi update --extensions` to reconcile package installations. See [Command Line](cli.md#package-commands) for every package command and option.

Personal installs are written to `~/.pi/agent/settings.json`. Add `--local` or `-l` to write the package declaration to `.pi/settings.json`. Pi reads declarations from that file only after project trust is granted.

Project packages are installed and loaded only after project trust is resolved. Packages can execute extension code and can include skills that instruct the model to run programs. Review third-party package source before installing it. Review project package declarations before granting project trust.

Use `--extension` or `-e` to try a package for one invocation without adding it to settings:

```bash
pi -e npm:@example/pi-tools
```

## Choose a source

| Source | Example | Behavior |
|---|---|---|
| npm | `npm:@example/pi-tools@1.0.0` | Installed under the Pi npm directory |
| git | `git:github.com/example/pi-tools@v1` | Cloned and reconciled to the selected ref |
| URL | `https://github.com/example/pi-tools` | Treated as a git source |
| Local | `./pi-tools` | Loaded from the resolved path without copying |

Versioned npm specifications are pinned. Git tags and commits are also pinned; package updates reconcile the checkout but do not move a configured ref.

Only the **xz-dev Bun-compiled standalone distribution** defaults to its embedded Bun for package operations. It invokes public `pi` through inherited `PATH`, adding `BUN_BE_BUN=1` only to package-manager child processes. This default applies even when npm is installed. Other distributions and source/npm installations retain npm, including source runs under Bun. This selection does not change Pi self-update.

Bun compatibility is not npm equivalence: registry/`.npmrc` handling, lockfiles, lifecycle scripts, and native dependencies can differ. Pi does not add blanket script trust or install missing native build tools. Use an explicit compatible `npmCommand` when needed; switching managers does not undo lockfile or dependency changes.
New git installs use depth-one, single-branch clones without unrelated tags. Branches and tags are selected during cloning; full commit IDs are fetched directly without cloning another branch. Abbreviated commit IDs require a full clone for local resolution; use a full commit ID to avoid downloading history.

Git updates fetch only the selected ref at depth one and discard stale commit-graph caches. Existing refs, reflogs, and stored objects are not automatically deleted; making an old clone shallow does not by itself reclaim all of its history.

When reconciliation changes the checkout, Pi resets and cleans the clone, then installs dependencies if `package.json` exists. Default npm uses `install --omit=dev --legacy-peer-deps`; embedded Bun uses `install --omit=dev --omit=peer`. This avoids installing Pi-provided host APIs again through peer dependencies. Explicit `npmCommand` commands use plain `install`. A current checkout with missing runtime dependencies is repaired without cleaning it; existing extra dependencies are not automatically pruned.

Relative local paths resolve from the settings file that contains them. A file path loads one extension. A directory follows normal package discovery rules.

## Create a package

The simplest package uses conventional directories:

```text
my-pi-package/
├── package.json
├── extensions/
├── skills/
├── prompts/
└── themes/
```

Without a `pi` manifest, Pi discovers TypeScript and JavaScript extensions, skill directories, Markdown prompts, and JSON themes from those directories.

Use an explicit manifest when resources live elsewhere or need filtering:

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./resources/skills"],
    "prompts": ["./resources/prompts/*.md"],
    "themes": ["./resources/themes/*.json"]
  }
}
```

Paths are relative to the package root. Arrays accept glob patterns and exclusions. List dot-prefixed or symlinked resource roots directly when traversal through a glob would not discover them.

The `pi-package` keyword makes an npm package eligible for discovery in the [Pi package gallery](https://pi.dev/packages). Optional `pi.image` and `pi.video` fields add gallery previews.

## Declare dependencies

Put runtime packages imported by extensions in `dependencies`. Pi installs package dependencies when it installs an npm or git source.

Pi supplies these packages to extensions and skills:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

Declare the host-provided packages listed above in `peerDependencies` with a `"*"` range and do not bundle them. Pi suppresses automatic peer installation for managed npm packages and git packages installed with npm, pnpm, or Bun. Local packages are not installed or modified, so their dependency tree remains the package author's responsibility.

Do not list host-provided packages in `dependencies`. A physical copy can bypass Pi's extension module mapping in compiled ESM and create duplicate classes, registries, and initialization work. Pi reports an extension warning when it detects this manifest configuration. Other Pi packages used as dependencies must be included in the published tarball and referenced through their `node_modules` resource paths.

Installed packages load with separate module roots. Do not rely on two packages sharing one dependency instance or one package resolving another package’s undeclared dependency.

## Select package resources

The object form in settings narrows which resources load from a package:

```json
{
  "packages": [
    {
      "source": "npm:@example/pi-tools",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"]
    }
  ]
}
```

For each resource type:

- Omit the property to load everything allowed by the package.
- Use `[]` to load none of that type.
- Use `!pattern` to exclude glob matches.
- Use `+path` to include one exact allowed path.
- Use `-path` to exclude one exact path.

A package may also set `skillOverrides` keyed by each skill's resolved `name`. Setting `disableModelInvocation` to `true` hides that skill from the model prompt while keeping `/skill:name` available; `false` overrides the skill's frontmatter. Unknown skill names are ignored, and overrides apply only to skills from that package. For an `autoload: false` project delta, same-name overrides replace global entries while unspecified skill overrides are inherited.

## Enable and Disable Resources

A package may also set `skillOverrides` keyed by each skill's resolved `name`. Setting `disableModelInvocation` to `true` hides that skill from the model prompt while keeping `/skill:name` available; `false` overrides the skill's frontmatter. Unknown skill names are ignored, and overrides apply only to skills from that package. For an `autoload: false` project delta, same-name overrides replace global entries while unspecified skill overrides are inherited.

Run `pi config` to enable or disable discovered resources. It starts with personal configuration; press Tab to switch scope, or run `pi config --local` to start with project overrides.

## Understand scope and identity

The same package can appear in personal and project settings. A project entry normally replaces the personal entry. With `autoload: false`, the project entry instead acts as a filtering delta over the personal package.

Pi identifies npm packages by package name, git packages by repository URL without the ref, and local packages by resolved absolute path. This prevents the same package from loading twice through equivalent declarations.

Use [Extensions](extensions.md), [Skills](skills.md), [Prompt Templates](prompt-templates.md), and [Themes](themes.md) to design each resource before packaging it.
