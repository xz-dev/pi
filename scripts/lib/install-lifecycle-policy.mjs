/**
 * Reviewed packages allowed to ship install-time lifecycle scripts.
 * Each digest is sha256 over sorted `scriptName\0scriptBody\0` records so a
 * package cannot change reviewed script content while retaining its version.
 */
export const DEFAULT_ALLOWED_INSTALL_SCRIPT_PACKAGES = new Map([
	["@google/genai@1.52.0", "3390cbc862c26e20f8d79f06a0f33f35fced786d67c185c7aae2e4d619e0355e"],
	["protobufjs@7.6.5", "37352a08b4a4aa13c7a3d65130e1341a42fac125e2f8416cde75baff769d9915"],
]);
