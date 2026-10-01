// Managed-bundle usage-claim bootstrap for the compiled Bun entrypoint.
//
// This module exists because ESM hoists and evaluates every static import of
// the entrypoint before any of its body statements run. Registering the
// session claim from a statement in bun/cli.ts would therefore evaluate
// sandbox-env-setup.ts and runtime-setup.ts first. Keeping the registration
// in this module and importing it FIRST makes module evaluation order carry
// the protocol: the claim is acquired before any module that could touch
// bundle resources is evaluated (design.md D3).

import { registerSessionUsageClaimAtStartup } from "../utils/bundle-usage-claim.ts";

registerSessionUsageClaimAtStartup(process.execPath);
