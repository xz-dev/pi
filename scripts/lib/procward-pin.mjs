// Only hand-maintained procward identity. Runtime/build manifests are derived from this object.
export const PROCWARD_PIN = Object.freeze({
	state: "release",
	version: "0.1.1",
	repository: "xz-dev/procward",
	workflow: ".github/workflows/release.yml",
	sourceCommit: "bb134c890823a54f1e2359352c7d8cd625e38beb",
	tag: "v0.1.1",
	developmentRun: null,
	targets: {
		"x86_64-unknown-freebsd": { zipSha256: "716a2aa730cb2f491e27885c094cbfc14cf9eafe58d0757c2fe507526dbc5992", binarySha256: "16acf066372ea4ed63b41c5b49794350745d1435df330e7b8d16254f0405cadb" },
		"aarch64-unknown-freebsd": { zipSha256: "3938f434da6169a4b152da499762996fa94c31e44d391cfe801b073b0931fa55", binarySha256: "b4d627edbb7169b8cdda2aab1422fd7423e598741569906ca08f782091f214c0" },
		"x86_64-apple-darwin": { zipSha256: "85a61aee8946b489f6d1fba9f162395bbd1eda1b7ccb26b357a71402107738f2", binarySha256: "ed18ffe303073f1f8ac3c85ff085ff80b39763d7e1dc43af7d3c5339a7ad16ec" },
		"aarch64-apple-darwin": { zipSha256: "5347ccae195f0c40e497767b4525ab3bf6cb490e9c8e0177ee6a859f9f5e0247", binarySha256: "3bd8c8fb94373d71a771cb9f2200b37f42982449de51170c3027abca4851a5db" },
		"x86_64-unknown-linux-gnu": { zipSha256: "f9a1b8834e5345dfddf30636874825bc51c6c87eee12bd719f96e32cd3ba896b", binarySha256: "cda284f7a57cc63b996f2dd854e0bdec6d6529bd86ae9d1c41c4d78944574388" },
		"aarch64-unknown-linux-gnu": { zipSha256: "87fb48518d1365c8dd43c6b8b833d0d84a52ac7b8262fb6bed69add884a46e24", binarySha256: "002749742f6087982c0bc4ff50b9f64078e71226eb38024f2181439c1ee74cfe" },
		"x86_64-unknown-linux-musl": { zipSha256: "0d70ce9e3d99dbbb68724b0d98885cf84db6a40e27ad05df00c598005d6ea465", binarySha256: "832df315d58a29ea8a918fe9a72fdc380ddf9c9b0136ec5c6ce58f90e7e0b146" },
		"aarch64-unknown-linux-musl": { zipSha256: "d6ad8e7fefdcab6ef964f75e7376b34698b2c26ab891a4857b7eaa1fe6e948b7", binarySha256: "42d519b159d90a147ede542d7beb278766fc60a6a541d337ee1c6802917c83ea" },
		"x86_64-pc-windows-msvc": { zipSha256: "05f8547fe8ecaf5db8b6770600c9d225a554c08951e1d0261a29b1c2d5cf4b77", binarySha256: "f9e9ef0a97c3312f5d42155fd2051161f492ea8e1e0cf36a056e55ebb5930144" },
		"aarch64-pc-windows-msvc": { zipSha256: "b480a07701fa9f08f30ce2605ca4ee2acd82226a64997c03be07a1123e3ad95e", binarySha256: "5b1dde78722c38f32a7e0cef85a7309e32adfc7b39510140804a3af626045844" },
	},
});
