# rustix source receipt

Pristine crates.io archive `rustix` 1.1.6.

- Source: https://crates.io/api/v1/crates/rustix/1.1.6/download
- SHA-256 / prior registry lock checksum: `e5e76742e5294153d4dde1207dbec5bdd81eef6fabdc0d2118babadabfd858aa`
- Upstream: https://github.com/bytecodealliance/rustix
- Original licences/COPYRIGHT are retained in `rustix/`.

Initial vendor commit preserves archive bytes without modifications. A following
minimal patch handles FreeBSD's -1 no-failed-PID sentinel; see PROCWARD-PATCH.md.
No additional runtime features are enabled by vendoring.
