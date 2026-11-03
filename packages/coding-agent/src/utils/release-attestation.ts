import { createHash } from "node:crypto";
import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import trustedRoot from "./sigstore-trusted-root.json" with { type: "json" };

// Sigstore public-good trust root, pinned independently of Release mirrors:
// https://github.com/sigstore/root-signing/blob/63134820c97beb38a82a7d34221f4c3db8215df5/targets/trusted_root.json
// Root rotations must be shipped in a trusted Pi update, never accepted from a mirror.
const verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(trustedRoot)), {
	tlogThreshold: 1,
	ctlogThreshold: 1,
	timestampThreshold: 1,
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Verify the manifest's publisher and bytes offline, using only bundled trust anchors. */
export function verifyReleaseAttestation(
	manifestBytes: Uint8Array,
	attestationBytes: Uint8Array,
	commit: string,
): void {
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Invalid attested Release commit");
	const manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
	let lastError: unknown;
	for (const line of new TextDecoder().decode(attestationBytes).split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			const bundle = bundleFromJSON(value);
			if (
				bundle.content.$case !== "dsseEnvelope" ||
				bundle.content.dsseEnvelope.payloadType !== "application/vnd.in-toto+json"
			) {
				throw new Error("Release attestation must contain an in-toto statement");
			}
			verifier.verify(toSignedEntity(bundle), {
				subjectAlternativeName:
					/^https:\/\/github\.com\/xz-dev\/pi\/\.github\/workflows\/publish-github-release\.yml@refs\/heads\/main$/,
				extensions: { issuer: "https://token.actions.githubusercontent.com" },
				// Fulcio v2 extensions: runner environment, source repository, commit, and ref.
				// These fixed ASCII policy values (including the validated commit) fit short DER UTF8Strings.
				oids: (
					[
						[11, "github-hosted"],
						[12, "https://github.com/xz-dev/pi"],
						[13, commit],
						[14, "refs/heads/main"],
					] as const
				).map(([suffix, text]) => ({
					oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, suffix] },
					value: Buffer.concat([Buffer.from([0x0c, Buffer.byteLength(text)]), Buffer.from(text)]),
				})),
			});
			const statement: unknown = JSON.parse(bundle.content.dsseEnvelope.payload.toString("utf8"));
			if (
				!isRecord(statement) ||
				statement._type !== "https://in-toto.io/Statement/v1" ||
				statement.predicateType !== "https://slsa.dev/provenance/v1" ||
				!Array.isArray(statement.subject)
			) {
				throw new Error("Invalid Release provenance statement");
			}
			const subjects = statement.subject.filter(
				(subject: unknown): subject is Record<string, unknown> =>
					isRecord(subject) && subject.name === "release-manifest.json",
			);
			if (subjects.length !== 1 || !isRecord(subjects[0].digest) || subjects[0].digest.sha256 !== manifestDigest) {
				throw new Error("Release manifest does not match its signed digest");
			}
			return;
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(
		`Release attestation verification failed: ${lastError instanceof Error ? lastError.message : "no signed manifest"}`,
		{ cause: lastError },
	);
}
