const DEFAULT_ENV_OVERRIDES = ["LC_ALL=C.UTF-8", "LANG=C.UTF-8", "LANGUAGE=en"];

/**
 * Apply `envOverrides` entries to `env`. Unset uses the English locale defaults;
 * a user list replaces them entirely; [] disables. Returns invalid entries.
 */
export function applyEnvOverrides(entries: string[] | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
	if (entries !== undefined && !Array.isArray(entries)) return [String(entries)];
	const invalid: string[] = [];
	for (const entry of entries ?? DEFAULT_ENV_OVERRIDES) {
		const index = typeof entry === "string" ? entry.indexOf("=") : -1;
		if (index <= 0) {
			invalid.push(String(entry));
			continue;
		}
		env[entry.slice(0, index)] = entry.slice(index + 1);
	}
	return invalid;
}
