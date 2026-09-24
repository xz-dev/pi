#!/usr/bin/env node
import "./sandbox-env-setup.ts";
import "./runtime-setup.ts";

async function bootstrap(): Promise<void> {
	await import("../cli.ts");
}

void bootstrap();
