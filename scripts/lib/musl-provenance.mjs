#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export function hashFileTree(root) {
	const files = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) files.push(path);
		}
	};
	visit(root);
	const entries = files.map((path) => ({ path, name: relative(root, path).replaceAll("\\", "/") }));
	entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
	const closure = createHash("sha256");
	for (const { path, name } of entries) {
		const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
		closure.update(`${name}\0${digest}\n`);
	}
	return closure.digest("hex");
}

export const MUSL_CLIPBOARD_PROVENANCE = Object.freeze({
	component: "@mariozechner/clipboard",
	upstreamVersion: "0.3.9",
	source: Object.freeze({
		url: "https://github.com/badlogic/clipboard/archive/3a0f58eb7250a9a46ad77863bc4618eee099a248.tar.gz",
		commit: "3a0f58eb7250a9a46ad77863bc4618eee099a248",
		archiveSha256: "55eaf95319b8a3e99ddc795c1539f0e72f0988d89359f7d4e5a91764dc3fd268",
		sourceTreeSha256: "d5d9b09e2e2207d723438a308a57012288908fe2eb4af79a35b25b1089d67ae9",
		vendorTreeSha256: "a4654a4f744b2534d7d7d59b0958fa87f5914eb426c9990aa73356cd9ad5f6ab",
		cargoLockSha256: "2a98c447e6398e737f6f494aece7b08cbf228641bdf0ffe78238be36e75e66d2",
		license: "MIT",
	}),
	build: Object.freeze({
		rust: "rustc 1.88.0 (6b00bc388 2025-06-23)",
		muslDev: "1.2.5-r12",
		targets: Object.freeze({
			x64: Object.freeze({ container: "docker.io/library/rust@sha256:64eba3726734dcfe89e0a62a0485007a3ab7c7372ce5b38c621d8812f70215f0", platform: "linux/amd64", hostMachine: "x86_64", triple: "x86_64-unknown-linux-musl", muslDevApkSha256: "1c2068d910cfdbbcb4eb107a5a478f8b48edf3a6311953c8fa5180c5190efab3" }),
			arm64: Object.freeze({ container: "docker.io/library/rust@sha256:eb5ce72a65a7b223c98892aa3cdabc97af7d73ff011ba0757dbf5a67c3809186", platform: "linux/arm64", hostMachine: "aarch64", triple: "aarch64-unknown-linux-musl", muslDevApkSha256: "576f4aabcfa01d10d6baa2d5d87de436b76e58ae76eedf9db7627051365e1fe3" }),
		}),
	}),
});

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
	const path = process.argv[2]?.split(".") ?? [];
	let value = MUSL_CLIPBOARD_PROVENANCE;
	for (const key of path) value = value?.[key];
	if (typeof value !== "string") throw new Error("Usage: musl-provenance.mjs <dot.path.to.string>");
	process.stdout.write(value);
}
