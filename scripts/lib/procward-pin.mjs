// Only hand-maintained procward identity. Runtime/build manifests are derived from this object.
export const PROCWARD_PIN = Object.freeze({
	state: "unpinned-dev",
	version: "0.1.0",
	repository: "xz-dev/procward",
	workflow: ".github/workflows/release.yml",
	sourceCommit: "12eb25b4e2bb41aaf83d2e5619933754692e8e5b",
	tag: null,
	// Main-branch CI dry-run; never release provenance. No workflow dispatch is needed by Pi.
	developmentRun: 40643608524,
	targets: {
		"x86_64-unknown-freebsd": { zipSha256: "61d5857be187fef5aca8a9091f83f0548c9f3a5af4bde0488c4c3d0bd643457f", binarySha256: "fd672f1c7464d3952bcf3cbbea51f2ae564f2f57c18e6b417d77b5270b7ede0e" },
		"aarch64-unknown-freebsd": { zipSha256: "18f5cf8c66e8a3345991de82bdedbf14bd69e3071b3ce3f8244e47a8a7a4118a", binarySha256: "e887be53ea32f8f0a909363ddffa4f0c9861a5b3566e34512467deca33d13958" },
		"x86_64-apple-darwin": { zipSha256: "b00ac1e17c8812451f448f48fe1f9bf693c3ae8f61a69253591c5561dd882c23", binarySha256: "28c194adf85313559c9b11795c9f586628a08c65397413e5aae0694523d72be4" },
		"aarch64-apple-darwin": { zipSha256: "e1abee0f65bf8ec4586016ea967a7800c8ac086f926395fc6ec08c2f87eb38e9", binarySha256: "31eba3fbae5ca0328a1d11b3b4191f0c766a9c7d1435f08a9f3f89d49c6a0d16" },
		"x86_64-unknown-linux-gnu": { zipSha256: "73b0b7e4a0135dcb4910e2ff28347f25209d47cb7cecee36ba43af428c62d902", binarySha256: "6ef4b7cd36fe5fe3c1d76448fe62ab559909af1fb4c02d399d5c20c21d9d3765" },
		"aarch64-unknown-linux-gnu": { zipSha256: "da724c4c2170542bd628d73adc8bbecc2ce7a63643136a7b64fdb6902b4ae599", binarySha256: "d9f2ef1870b55723681070d9e3f4daa62f8c9f47538fbb40e09601451dd8a49b" },
		"x86_64-unknown-linux-musl": { zipSha256: "a051c0da41071b574e389c0397d2c7c55d5d8d6f0a8a8f9a436ecd3e6b038705", binarySha256: "26a02c7a2b1ad0590897ee4ade6591ed13286f2c46f6989c1937518de150e8bb" },
		"aarch64-unknown-linux-musl": { zipSha256: "4f65269632aa00884d4892b253b7cb0741c06ed794285d7f916601b18b88c6bc", binarySha256: "e9271d69ee561ea20746f50558c1d7b5c9f64364eeaf5e37160a7c6e56ee2f8d" },
		"x86_64-pc-windows-msvc": { zipSha256: "8d4c9dc962cc7908f119fc2cb3a02350696661d43a48f15b2082f64018d9587d", binarySha256: "220d6d9b1ecbd533507f310e74340908d8c208d68aed9154cc3efa1f7f222f6f" },
		"aarch64-pc-windows-msvc": { zipSha256: "0de7be5afb8b53502d4e711d7ef1ee68bdf728cd82fb49aca0f96d3b7093a6b8", binarySha256: "dd9b1896458b4030bc5ccd66b964b2960a7b17eaeb9f2148bcab8dab473759a9" },
	},
});
