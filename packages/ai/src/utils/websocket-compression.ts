import { sha256Hex } from "./response-checkpoints.ts";

// A declined extension stays disabled for this target/auth scope until process exit.
const declined = new Set<string>();

/** Read the accepted extension, not the client's compression offer. */
export function getWebSocketCompressionEncoding(extensions: string | undefined): "deflate" | undefined {
	return extensions?.split(",").some((extension) => extension.trim().split(";", 1)[0] === "permessage-deflate")
		? "deflate"
		: undefined;
}

export async function getWebSocketCompressionPolicy(url: string, headers: ConstructorParameters<typeof Headers>[0]) {
	const effective = new Headers(headers);
	const credentials = ["authorization", "x-api-key", "api-key", "chatgpt-account-id"].map((name) => [
		name,
		effective.get(name),
	]);
	const key = await sha256Hex(`${url}\n${JSON.stringify(credentials)}`);
	return {
		perMessageDeflate: declined.has(key)
			? false
			: {
					clientNoContextTakeover: true,
					zlibDeflateOptions: { level: 4 },
				},
		recordNegotiated(extensions: string): void {
			if (!getWebSocketCompressionEncoding(extensions)) {
				declined.add(key);
			}
		},
	};
}
