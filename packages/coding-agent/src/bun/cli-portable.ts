#!/usr/bin/env node
// Entry for the portable single-executable build. Unlike `bun/cli.ts`, this
// requires no usage-claim bootstrap and no `pi-wrapper` companion — the
// compiled binary IS the public `pi-<release-target>` executable.
import "../cli-bootstrap.ts";
import { materializeNativeAddons } from "../config.ts";

// Initializers must stay behind the ownership decision, including for compiled entries.
await import("./sandbox-env-setup.ts");
await import("./runtime-setup.ts");

// Register the materialized-native-addon provider before anything can ask for
// a `.node` path. The provider only materializes when a native module is
// actually requested, so --version/--help stay disk-free.
(globalThis as Record<symbol, unknown>)[Symbol.for("@earendil-works/pi-coding-agent:materialize-native-addons")] =
	materializeNativeAddons;
await import("../cli.ts");
