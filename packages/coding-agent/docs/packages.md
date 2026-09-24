# Pi Packages

Pi packages install and distribute extensions, skills, prompt templates, and themes as one unit. Use a package when a customization should be shared through npm or git, or when several resources belong together.

A package is an ordinary directory or npm package. It can expose conventional resource directories, declare explicit paths under the `pi` key in `package.json`, and carry its own runtime dependencies.

## Install and manage packages

Install from npm, git, or a local path:

```bash
pi install npm:@example/pi-tools@1.0.0
pi install git:github.com/example/pi-tools@v1
pi install ./local-package
```

`pi list` shows configured packages. Use `pi remove <source>` to remove one and `pi update --extensions` to reconcile package installations. See [Command Line](cli.md#package-commands) for every package command and option.

Personal installs are written to `~/.pi/agent/settings.json`. Add `--local` or `-l` to write the package declaration to `.pi/settings.json`. Pi reads declarations from that file only after project trust is granted.

Project packages are installed and loaded only after project trust is resolved. Packages can execute extension code and can include skills that instruct the model to run programs. Review third-party package source before installing it. Review project package declarations before granting project trust.

Use `--extension` or `-e` to try a package for one invocation without adding it to settings:

```bash
pi -e npm:@example/pi-tools
```

## Package-manager selection

A non-empty `npmCommand` array overrides the package manager, preserving executable and wrapper arguments. An empty array selects the default; `[""]` is invalid.

Only the **xz-dev Bun-compiled standalone distribution** defaults to its embedded Bun. It invokes public `pi` through inherited `PATH`, adding `BUN_BE_BUN=1` only to package-manager child processes. This default applies even when npm is installed. Other distributions and source/npm installations retain npm, including source runs under Bun. This selection does not change Pi self-update.

Keep a compatible public `pi` on `PATH`. The first matching wrapper or installation wins, even if it differs from the one that launched the session. Launching Pi by absolute path does not bypass this requirement. A missing or failing entry produces an error; Pi does not fall back to npm or invoke `pi-native` directly.

To use an installed external manager instead:

```json
{ "npmCommand": ["npm"] }
```

Explicit `npmCommand` commands receive no injected embedded-Bun flag. Wrappers remain supported, for example `["mise", "exec", "node@20", "--", "npm"]`. Recognized Bun commands use `info` for version queries instead of npm's `view`. The embedded default uses `bun update` for managed npm updates so compatible newer versions are resolved instead of retaining the installed lockfile version; configured source selectors remain unchanged. If a configured package is missing from the managed npm project's dependency declarations, Pi first installs that package with its configured selector, then updates the batch. This repairs settings/manifest drift instead of asking Bun to update an undeclared package.

User, trusted-project, and temporary package locations are unchanged. Git remains separately required for Git sources. Bun compatibility is not npm equivalence: registry/`.npmrc` handling, lockfiles, lifecycle scripts, and native dependencies can differ. Pi does not add blanket script trust or install missing native build tools. Use an explicit compatible `npmCommand` when needed; switching managers does not undo lockfile or dependency changes.

For npm v2/v3 lockfile migration, the embedded default temporarily omits npm packing integrity values only for Git dependencies whose `resolved` URL pins a full 40-character commit. Bun downloads a different Git archive and cannot use those packing hashes. Pi restores the original `package-lock.json` bytes after success or failure and serializes these temporary edits. Registry and HTTP tarball integrity checks remain enabled; Pi never adds `--no-verify`. Existing `bun.lock`/`bun.lockb`, npm shrinkwrap files, unpinned Git entries, and explicit package-manager overrides are unchanged. The compatibility path relies on the Git commit pin rather than the npm tarball hash. Forced process termination can interrupt restoration.

Official Bun 1.4.2 rejects metadata queries from a working directory without `package.json`. If the embedded default cannot verify an installed package's target version, Pi prints the lookup error and warns that continuing with Bun may downgrade the package, then attempts the requested update. Successful version queries still skip equal or older targets, and exact pins remain pinned. Availability checks omit failed lookups. Pi does not create a project manifest, change the query directory, or switch managers. Explicit overrides and other installations retain their existing lookup-error policy.

## Choose a source

| Source | Example | Behavior |
|---|---|---|
| npm | `npm:@example/pi-tools@1.0.0` | Installed under the Pi npm directory |
| git | `git:github.com/example/pi-tools@v1` | Cloned and reconciled to the selected ref |
| URL | `https://github.com/example/pi-tools` | Treated as a git source |
| Local | `./pi-tools` | Loaded from the resolved path without copying |

Versioned npm specifications are pinned. Git tags and commits are also pinned; package updates reconcile the checkout but do not move a configured ref.

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

Filters narrow the package manifest. They do not expose resources that the package itself did not declare.

Run `pi config` to enable or disable discovered resources. It starts with personal configuration; press Tab to switch scope, or run `pi config --local` to start with project overrides.

## Understand scope and identity

The same package can appear in personal and project settings. A project entry normally replaces the personal entry. With `autoload: false`, the project entry instead acts as a filtering delta over the personal package.

Pi identifies npm packages by package name, git packages by repository URL without the ref, and local packages by resolved absolute path. This prevents the same package from loading twice through equivalent declarations.

Use [Extensions](extensions.md), [Skills](skills.md), [Prompt Templates](prompt-templates.md), and [Themes](themes.md) to design each resource before packaging it.
