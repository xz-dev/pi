import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishGitHubRelease } from "./publish-github-release.mjs";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VERSION = "0.82.1-xz.123.1.gaaaaaaaa";
const TAG = `xz-v${VERSION}`;
const PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "windows-arm64",
  "windows-x64",
];
function bundleFile(platform) {
  return `pi-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`;
}
const BUNDLE_FILES = PLATFORMS.map(bundleFile);
const ENV = {
  GITHUB_REPOSITORY: "xz-dev/pi",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "push",
  GITHUB_SHA: SHA,
  GITHUB_RUN_NUMBER: "123",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_TOKEN: "test-token",
};

function digest(body) {
  return createHash("sha256").update(body).digest("hex");
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-release-publisher-"));
  const files = new Map([
    ...BUNDLE_FILES.map((file) => [file, Buffer.from(`bundle:${file}`)]),
    ["release-manifest.json", Buffer.from("")],
    ["install.sh", Buffer.from("sh")],
    ["install.ps1", Buffer.from("ps1")],
    ["SHA256SUMS", Buffer.from("sums")],
  ]);
  const manifest = {
    schemaVersion: 3,
    repository: "xz-dev/pi",
    tag: TAG,
    distributionVersion: VERSION,
    commit: SHA,
    minimumNodeVersion: "22.19.0",
    packaging: "binary",
    layoutVersion: 1,
    bundles: Object.fromEntries(
      PLATFORMS.map((platform) => [
        platform,
        {
          file: bundleFile(platform),
          bytes: files.get(bundleFile(platform)).byteLength,
          sha256: digest(files.get(bundleFile(platform))),
        },
      ]),
    ),
    installer: {
      posix: { file: "install.sh" },
      windows: { file: "install.ps1" },
      checksums: { file: "SHA256SUMS", algorithm: "sha256" },
    },
    attestation: {
      repository: "xz-dev/pi",
      signerWorkflow: "xz-dev/pi/.github/workflows/publish-github-release.yml",
      signerRef: "refs/heads/main",
      denySelfHostedRunners: true,
      subjectsFile: "attestation-subjects.txt",
    },
    bootstrap: {
      tag: TAG,
      baseUrl: `https://github.com/xz-dev/pi/releases/download/${TAG}/`,
      minimumNodeVersion: "22.19.0",
      files: { sh: "install.sh", ps1: "install.ps1" },
    },
  };
  files.set(
    "release-manifest.json",
    Buffer.from(`${JSON.stringify(manifest)}\n`),
  );
  for (const [name, body] of files) writeFileSync(join(directory, name), body);
  const subjects = [...files.keys()];
  writeFileSync(
    join(directory, "attestation-subjects.txt"),
    `${subjects.join("\n")}\n`,
  );
  return {
    directory,
    manifestPath: join(directory, "release-manifest.json"),
    assetBodies: new Map([
      ...files,
      [
        "attestation-subjects.txt",
        readFileSync(join(directory, "attestation-subjects.txt")),
      ],
    ]),
  };
}

function response(status, body) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function release({ draft, assets, target = SHA, id = 7 }) {
  return {
    id,
    tag_name: TAG,
    target_commitish: target,
    draft,
    prerelease: false,
    html_url: `https://github.com/xz-dev/pi/releases/tag/${TAG}`,
    upload_url: "https://uploads.github.test/releases/7/assets{?name,label}",
    assets: [...assets.entries()].map(([name, body], index) => ({
      id: index + 1,
      name,
      url: `https://api.github.test/assets/${index + 1}`,
      digest: `sha256:${digest(body)}`,
    })),
  };
}

async function withFetch(mock, body) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

test("creates a draft, uploads every bundle asset plus subjects, then publishes after latest ref recheck", async () => {
  const candidate = fixture();
  const assets = new Map();
  let currentRelease;
  const events = [];
  try {
    await withFetch(
      async (url, options = {}) => {
        const method = options.method ?? "GET";
        const text = String(url);
        if (text.includes(`/releases/tags/${encodeURIComponent(TAG)}`)) {
          events.push("read-release");
          return currentRelease && !currentRelease.draft
            ? response(200, currentRelease)
            : response(404, { message: "Not Found" });
        }
        if (text.includes("/releases?per_page=100&page=1")) {
          return response(200, currentRelease?.draft ? [currentRelease] : []);
        }
        if (text.endsWith("/releases/7") && method === "GET") {
          return response(200, currentRelease);
        }
        if (text.endsWith("/releases") && method === "POST") {
          const input = JSON.parse(options.body);
          assert.equal(input.draft, true);
          assert.equal(input.prerelease, false);
          currentRelease = release({ draft: true, assets });
          events.push("create-draft");
          return response(201, currentRelease);
        }
        if (
          text.startsWith("https://uploads.github.test/") &&
          method === "POST"
        ) {
          const name = new URL(text).searchParams.get("name");
          assets.set(name, Buffer.from(options.body));
          currentRelease = release({ draft: true, assets });
          events.push(`upload:${name}`);
          return response(201, { name });
        }
        if (text.endsWith("/branches/main")) {
          events.push("latest-ref-recheck");
          return response(200, { commit: { sha: SHA } });
        }
        if (text.endsWith("/releases/7") && method === "PATCH") {
          const input = JSON.parse(options.body);
          assert.deepEqual(input, {
            draft: false,
            prerelease: false,
            make_latest: "true",
          });
          assert.equal(assets.size, candidate.assetBodies.size);
          currentRelease = release({ draft: false, assets });
          events.push("publish");
          return response(200, currentRelease);
        }
        throw new Error(`Unexpected request ${method} ${text}`);
      },
      () => publishGitHubRelease(candidate.manifestPath, ENV),
    );

    assert.deepEqual(
      [...assets.keys()].sort(),
      [...candidate.assetBodies.keys()].sort(),
    );
    for (const file of BUNDLE_FILES) {
      assert.ok(assets.has(file), `missing uploaded bundle ${file}`);
    }
    assert.ok(events.indexOf("latest-ref-recheck") < events.indexOf("publish"));
    assert.ok(events.indexOf("upload:attestation-subjects.txt") < events.indexOf("latest-ref-recheck"));
  } finally {
    rmSync(candidate.directory, { recursive: true, force: true });
  }
});

test("resumes an exact draft subset without overwriting existing assets", async () => {
  const candidate = fixture();
  const first = [...candidate.assetBodies.entries()][0];
  const assets = new Map([first]);
  let currentRelease = release({ draft: true, assets });
  const uploaded = [];
  try {
    await withFetch(
      async (url, options = {}) => {
        const method = options.method ?? "GET";
        const text = String(url);
        if (text.includes(`/releases/tags/${encodeURIComponent(TAG)}`))
          return response(404, { message: "Not Found" });
        if (text.includes("/releases?per_page=100&page=1"))
          return response(200, [currentRelease]);
        if (text.endsWith("/releases/7") && method === "GET")
          return response(200, currentRelease);
        if (
          text.startsWith("https://uploads.github.test/") &&
          method === "POST"
        ) {
          const name = new URL(text).searchParams.get("name");
          uploaded.push(name);
          assets.set(name, Buffer.from(options.body));
          currentRelease = release({ draft: true, assets });
          return response(201, { name });
        }
        if (text.endsWith("/branches/main"))
          return response(200, {
            commit: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
          });
        if (text.endsWith("/releases/7") && method === "PATCH") {
          assert.equal(JSON.parse(options.body).make_latest, "false");
          currentRelease = release({ draft: false, assets });
          return response(200, currentRelease);
        }
        throw new Error(`Unexpected request ${method} ${text}`);
      },
      () => publishGitHubRelease(candidate.manifestPath, ENV),
    );
    assert.ok(!uploaded.includes(first[0]));
    assert.equal(assets.size, candidate.assetBodies.size);
  } finally {
    rmSync(candidate.directory, { recursive: true, force: true });
  }
});

test("published identical release is a no-op and published partial release fails", async () => {
  const candidate = fixture();
  try {
    for (const [assets, shouldPass] of [
      [candidate.assetBodies, true],
      [new Map([...candidate.assetBodies].slice(0, -1)), false],
    ]) {
      let mutations = 0;
      const run = () =>
        withFetch(
          async (url, options = {}) => {
            if ((options.method ?? "GET") !== "GET") mutations += 1;
            if (
              String(url).includes(`/releases/tags/${encodeURIComponent(TAG)}`)
            ) {
              return response(200, release({ draft: false, assets }));
            }
            throw new Error(`Unexpected request ${url}`);
          },
          () => publishGitHubRelease(candidate.manifestPath, ENV),
        );
      if (shouldPass) await run();
      else await assert.rejects(run, /incomplete asset set/);
      assert.equal(mutations, 0);
    }
  } finally {
    rmSync(candidate.directory, { recursive: true, force: true });
  }
});

test("draft with an unexpected asset fails before upload or publication", async () => {
  const candidate = fixture();
  const unexpected = new Map([["foreign.txt", Buffer.from("foreign")]]);
  let mutations = 0;
  try {
    await assert.rejects(
      () =>
        withFetch(
          async (url, options = {}) => {
            if ((options.method ?? "GET") !== "GET") mutations += 1;
            if (
              String(url).includes(
                `/releases/tags/${encodeURIComponent(TAG)}`,
              )
            ) {
              return response(
                200,
                release({ draft: true, assets: unexpected }),
              );
            }
            throw new Error(`Unexpected request ${url}`);
          },
          () => publishGitHubRelease(candidate.manifestPath, ENV),
        ),
      /unexpected asset foreign\.txt/,
    );
    assert.equal(mutations, 0);
  } finally {
    rmSync(candidate.directory, { recursive: true, force: true });
  }
});

test("empty public attestation bundle fails before any GitHub request", async () => {
  const candidate = fixture();
  let requests = 0;
  try {
    writeFileSync(join(candidate.directory, "attestation-subjects.txt"), "");
    await assert.rejects(
      () =>
        withFetch(
          async () => {
            requests += 1;
            throw new Error("GitHub must not be called");
          },
          () => publishGitHubRelease(candidate.manifestPath, ENV),
        ),
      /empty attestation bundle/,
    );
    assert.equal(requests, 0);
  } finally {
    rmSync(candidate.directory, { recursive: true, force: true });
  }
});

for (const [field, mutate] of [
  ["installer", (manifest) => { manifest.installer.posix.file = "substitute.sh"; }],
  ["attestation workflow", (manifest) => { manifest.attestation.signerWorkflow = "evil/workflow.yml"; }],
  ["checksum metadata", (manifest) => { manifest.installer.checksums.algorithm = "sha512"; }],
  ["bundles", (manifest) => { delete manifest.bundles["windows-arm64"]; }],
]) {
  test(`manifest ${field} substitution fails before any GitHub request`, async () => {
    const candidate = fixture();
    let requests = 0;
    try {
      const manifest = JSON.parse(readFileSync(candidate.manifestPath, "utf8"));
      mutate(manifest);
      writeFileSync(candidate.manifestPath, `${JSON.stringify(manifest)}\n`);
      await assert.rejects(
        () =>
          withFetch(
            async () => {
              requests += 1;
              throw new Error("GitHub must not be called");
            },
            () => publishGitHubRelease(candidate.manifestPath, ENV),
          ),
        /Invalid GitHub Release manifest/,
      );
      assert.equal(requests, 0);
    } finally {
      rmSync(candidate.directory, { recursive: true, force: true });
    }
  });
}

test("draft asset mismatch fails before upload or publication", async () => {
  const candidate = fixture();
  const [name] = candidate.assetBodies.keys();
  const mismatched = new Map([[name, Buffer.from("tampered")]]);
  let mutations = 0;
  try {
    await assert.rejects(
      () =>
        withFetch(
          async (url, options = {}) => {
            if ((options.method ?? "GET") !== "GET") mutations += 1;
            if (
              String(url).includes(`/releases/tags/${encodeURIComponent(TAG)}`)
            ) {
              return response(
                200,
                release({ draft: true, assets: mismatched }),
              );
            }
            throw new Error(`Unexpected request ${url}`);
          },
          () => publishGitHubRelease(candidate.manifestPath, ENV),
        ),
      /sha256 mismatch/,
    );
    assert.equal(mutations, 0);
  } finally {
    rmSync(candidate.directory, { recursive: true, force: true });
  }
});
