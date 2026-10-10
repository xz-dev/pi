import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyReleaseAttestation } from "../src/utils/release-attestation.ts";
import trustedRoot from "../src/utils/sigstore-trusted-root.json" with { type: "json" };
import foreign from "./fixtures/foreign-release-attestation.json" with { type: "json" };
import fixture from "./fixtures/xz-release-attestation.json" with { type: "json" };

const manifest = Buffer.from(fixture.manifestBase64, "base64");
const commit = "02d10232dfe62ef6c568146cbae152ee07a5dc44";
const attestations = Buffer.from(fixture.attestations.map((bundle) => JSON.stringify(bundle)).join("\n"));

afterEach(() => vi.unstubAllGlobals());

describe("Release attestation verification", () => {
	it("authenticates a real published manifest entirely offline", () => {
		const fetchMock = vi.fn(() => {
			throw new Error("Unexpected network request");
		});
		vi.stubGlobal("fetch", fetchMock);
		expect(() => verifyReleaseAttestation(manifest, attestations, commit)).not.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a cryptographically valid proof from another repository and workflow", () => {
		const verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(trustedRoot)));
		expect(() => verifier.verify(toSignedEntity(bundleFromJSON(foreign.bundle)))).not.toThrow();
		expect(() => verifyReleaseAttestation(manifest, Buffer.from(JSON.stringify(foreign.bundle)), commit)).toThrow(
			"certificate identity error",
		);
	});

	it("rejects changed manifest bytes even when the JSON still represents the same release", () => {
		expect(() =>
			verifyReleaseAttestation(Buffer.concat([manifest, Buffer.from("\n")]), attestations, commit),
		).toThrow("does not match its signed digest");
	});

	it("binds the manifest commit to the authenticated signing certificate", () => {
		expect(() => verifyReleaseAttestation(manifest, attestations, "a".repeat(40))).toThrow("verification failed");
	});

	it.each(["", "{}", "not json"])("rejects missing or malformed proof %j", (proof) => {
		expect(() => verifyReleaseAttestation(manifest, Buffer.from(proof), commit)).toThrow("verification failed");
	});

	it.each([
		[
			"signature",
			(bundle: (typeof fixture.attestations)[number]) => {
				bundle.dsseEnvelope.signatures[0].sig = Buffer.alloc(64).toString("base64");
			},
		],
		[
			"signing certificate",
			(bundle: (typeof fixture.attestations)[number]) => {
				bundle.verificationMaterial.certificate.rawBytes = Buffer.from("not a certificate").toString("base64");
			},
		],
		[
			"transparency log entry",
			(bundle: (typeof fixture.attestations)[number]) => {
				bundle.verificationMaterial.tlogEntries[0].logIndex = "0";
			},
		],
		[
			"missing transparency proof",
			(bundle: (typeof fixture.attestations)[number]) => {
				bundle.verificationMaterial.tlogEntries = [];
			},
		],
	] as const)("rejects a tampered %s", (_name, tamper) => {
		const bundle = structuredClone(fixture.attestations[0]);
		tamper(bundle);
		expect(() => verifyReleaseAttestation(manifest, Buffer.from(JSON.stringify(bundle)), commit)).toThrow(
			"verification failed",
		);
	});
});
