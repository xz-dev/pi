export function formatFatalError(error: unknown): string {
	if (error instanceof Error && error.stack?.trim()) return error.stack;
	if (error instanceof DOMException || error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

export async function runMain(main: () => Promise<void>): Promise<void> {
	try {
		await main();
	} catch (error) {
		console.error(formatFatalError(error));
		process.exitCode = 1;
	}
}
