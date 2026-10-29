// Only hand-maintained procward identity. Runtime/build manifests are derived from this object.
export const PROCWARD_PIN = Object.freeze({
	state: "release",
	version: "0.1.0",
	repository: "xz-dev/procward",
	workflow: ".github/workflows/release.yml",
	sourceCommit: "bd5d3624c46d458c25b863dba978b2298f097691",
	tag: "v0.1.0",
	developmentRun: null,
	targets: {
		"x86_64-unknown-freebsd": { zipSha256: "3e82ec1d5799c4425e4193dd11e98202574df1bd01c0fcad6fe6874facffaec3", binarySha256: "8864146a2041b2d1a08a6d81c3d7c03a793ccce362e4b35873518d48762237fe" },
		"aarch64-unknown-freebsd": { zipSha256: "557fbc3dee51cb6e28ca087b0689f3b3e36a3b9782c3cec1a7871ed34e7759f2", binarySha256: "935157f50dad03b88c47df4d02ceb666a636c8bba1e66afe4ca8bb8780099629" },
		"x86_64-apple-darwin": { zipSha256: "3f9e26e48b1bbda44c5c2157a9027b148589f3f08bf49c66c06cc69324182562", binarySha256: "7fd3050e775511c98ef4f3a38e5765208bfe2468f116bea46fa9710806f1f7f4" },
		"aarch64-apple-darwin": { zipSha256: "d678185dfa9e457f93335e047288d83f19c74e78295ddf5914c21d0952a48532", binarySha256: "ee3869489c077bac6940611a75e6b187e75e96657f72b199ae9c0f738628394a" },
		"x86_64-unknown-linux-gnu": { zipSha256: "94afc3ec91f1da89aa48b2e78b02ae69faea008d1b0779168684086553f52a32", binarySha256: "3667c3901e197d60043f4cb2f44afce5377687f85c15b6147af29f0a066dac22" },
		"aarch64-unknown-linux-gnu": { zipSha256: "e34fbd4d6f70d6ff8286d4814f1c419183c824479d71256eff9262b083135dcd", binarySha256: "aed3b817c10436e21bb490d64abd76ef6627dd4ecdc7ca7fc1ee7e1616601182" },
		"x86_64-unknown-linux-musl": { zipSha256: "f167807a1eb0d439831d11fba1fb3cc6ba24d809dbcabb0b5ab575121986e221", binarySha256: "107d3271ab427e6885fb2fa7f59ecd60e5fbe8de55d33a9216df731226e8aa69" },
		"aarch64-unknown-linux-musl": { zipSha256: "9ed451a6683923aab38b8fa2ed2155ce296d37fd22ef7f53b4243708848634d3", binarySha256: "25af7aad69f09d2e9971976c3cfd1a5e13e357f159d0a8cc878637fd28de936c" },
		"x86_64-pc-windows-msvc": { zipSha256: "8acee160eed8aa3b8800726c2fbccdf4d9363844f73d6f0c835f225d5514eec8", binarySha256: "ab03b2051b8dd6ecd391b466bf0c01d7964cb1535acf83cd3a248bd96aa58284" },
		"aarch64-pc-windows-msvc": { zipSha256: "bda078c254bfa0b5e445c1301ab87a67eb25f09ac7615619fbd0acdc66f23b24", binarySha256: "eb4c88af45aa69f5b4abce665e9e9b5479e28ebe6876b85d56af8085ea47a0f9" },
	},
});
