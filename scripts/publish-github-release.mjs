#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { BUN_TARGET_IDS, binaryArchiveName } from "./lib/bun-targets.mjs";

const EXPECTED_REPOSITORY = "xz-dev/pi";
const EXPECTED_REF = "refs/heads/main";
const EXPECTED_EVENT_NAMES = new Set(["push", "workflow_dispatch"]);
const API_VERSION = "2022-11-28";
const USER_AGENT = "xz-dev-pi-github-release-publisher";

function usage() {
  return "Usage: node scripts/publish-github-release.mjs <release-manifest.json>";
}

function fail(message) {
  throw new Error(message);
}

function requiredEnv(name, env = process.env) {
  const value = env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readManifest(path) {
  if (basename(path) !== "release-manifest.json") {
    fail("Release manifest filename must be release-manifest.json");
  }
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (
    manifest.schemaVersion !== 5 ||
    manifest.repository !== EXPECTED_REPOSITORY ||
    typeof manifest.distributionVersion !== "string" ||
    typeof manifest.tag !== "string" ||
    manifest.tag !== `xz-v${manifest.distributionVersion}` ||
    manifest.packaging !== "binary" ||
    manifest.layoutVersion !== 2 ||
    typeof manifest.bundles !== "object" ||
    manifest.bundles === null ||
    Array.isArray(manifest.bundles) ||
    Object.keys(manifest.bundles).length !== BUN_TARGET_IDS.length ||
    !BUN_TARGET_IDS.every((target) => manifest.bundles[target]?.file === binaryArchiveName(target)) ||
    manifest.acceptance?.file !== "binary-acceptance.json" ||
    manifest.acceptance?.targetCount !== BUN_TARGET_IDS.length ||
    manifest.attestation?.subjectsFile !== "attestation-subjects.jsonl" ||
    manifest.attestation?.repository !== EXPECTED_REPOSITORY ||
    manifest.attestation?.signerWorkflow !== `${EXPECTED_REPOSITORY}/.github/workflows/publish-github-release.yml` ||
    manifest.attestation?.signerRef !== EXPECTED_REF ||
    manifest.attestation?.denySelfHostedRunners !== true
  ) {
    fail("Invalid GitHub Release manifest");
  }
  return manifest;
}

function releaseAssetPaths(releaseDir, manifest) {
  const subjectsFile = manifest.attestation.subjectsFile;
  const subjectsPath = join(releaseDir, basename(subjectsFile));
  if (!existsSync(subjectsPath) || readFileSync(subjectsPath).byteLength === 0)
    fail(`Missing or empty attestation bundle: ${subjectsPath}`);
  const expectedSubjects = [
    ...Object.values(manifest.bundles).map((bundle) => bundle.file),
    "release-manifest.json",
    "binary-acceptance.json",
    "SHA256SUMS",
  ];
  const subjectPaths = expectedSubjects.map((line) => join(releaseDir, line));
  const paths = [...subjectPaths, subjectsPath];
  const names = paths.map((path) => basename(path));
  if (new Set(names).size !== names.length)
    fail("Release candidate contains duplicate asset names");
  for (const path of paths) {
    if (!existsSync(path)) fail(`Missing release asset: ${path}`);
  }
  return paths;
}

function releaseAssetDigests(paths) {
  return new Map(paths.map((path) => [basename(path), sha256File(path)]));
}

function headers(token, extra = {}) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": API_VERSION,
    ...extra,
  };
}

async function request(url, options, expectedStatuses) {
  const response = await fetch(url, options);
  if (expectedStatuses.includes(response.status)) return response;
  const detail = (await response.text()).slice(0, 4_000);
  fail(
    `GitHub API ${options.method ?? "GET"} ${url} failed (${response.status}): ${detail}`,
  );
}

async function jsonRequest(url, options, expectedStatuses = [200]) {
  const response = await request(url, options, expectedStatuses);
  return response.status === 204 ? undefined : response.json();
}

function repositoryApi(repository) {
  return `https://api.github.com/repos/${repository}`;
}

async function getReleaseByTag(api, tag, token) {
  const publishedResponse = await fetch(
    `${api}/releases/tags/${encodeURIComponent(tag)}`,
    { headers: headers(token) },
  );
  if (publishedResponse.ok) return publishedResponse.json();
  if (publishedResponse.status !== 404) {
    const detail = (await publishedResponse.text()).slice(0, 4_000);
    fail(`GitHub API release lookup failed (${publishedResponse.status}): ${detail}`);
  }

  // GitHub's tag endpoint does not return drafts. List authenticated Releases so
  // an interrupted draft can be resumed without creating a duplicate tag.
  for (let page = 1; page <= 100; page += 1) {
    const releases = await jsonRequest(
      `${api}/releases?per_page=100&page=${page}`,
      { headers: headers(token) },
    );
    if (!Array.isArray(releases)) fail("GitHub API Releases list is invalid");
    const matching = releases.find((release) => release?.tag_name === tag);
    if (matching) return matching;
    if (releases.length < 100) return undefined;
  }
  fail("GitHub API Release lookup exceeded 100 pages");
}

async function getReleaseById(api, releaseId, token) {
  return jsonRequest(`${api}/releases/${releaseId}`, {
    headers: headers(token),
  });
}

async function resolveAssetDigest(asset, token) {
  if (typeof asset.digest === "string" && asset.digest.startsWith("sha256:")) {
    return asset.digest.slice("sha256:".length);
  }
  const response = await request(
    asset.url,
    { headers: headers(token, { Accept: "application/octet-stream" }) },
    [200],
  );
  return createHash("sha256")
    .update(Buffer.from(await response.arrayBuffer()))
    .digest("hex");
}

async function inspectExistingAssets(
  release,
  expectedDigests,
  token,
  { allowSubset },
) {
  if (!Array.isArray(release.assets)) fail(`Existing Release ${release.tag_name} has no asset list`);
  const assets = new Map();
  for (const asset of release.assets) {
    if (assets.has(asset.name)) fail(`Existing Release ${release.tag_name} has duplicate asset ${asset.name}`);
    assets.set(asset.name, asset);
  }
  for (const name of assets.keys()) {
    if (!expectedDigests.has(name)) {
      fail(`Existing Release ${release.tag_name} has unexpected asset ${name}`);
    }
  }
  if (!allowSubset && assets.size !== expectedDigests.size) {
    fail(
      `Existing published Release ${release.tag_name} has an incomplete asset set`,
    );
  }
  for (const [name, asset] of assets) {
    const actualDigest = await resolveAssetDigest(asset, token);
    if (actualDigest !== expectedDigests.get(name)) {
      fail(`Existing Release asset ${name} sha256 mismatch`);
    }
  }
  return assets;
}

function assertReleaseIdentity(release, tag, commit) {
  if (release.tag_name !== tag)
    fail(`Existing Release tag ${release.tag_name} does not match ${tag}`);
  if (release.prerelease)
    fail(`Existing Release ${release.tag_name} is a prerelease`);
  if (release.target_commitish !== commit) {
    fail(
      `Existing Release ${release.tag_name} targets ${release.target_commitish}, expected ${commit}`,
    );
  }
}

async function mainBranchSha(api, token) {
  const branch = await jsonRequest(`${api}/branches/main`, {
    headers: headers(token),
  });
  const sha = branch?.commit?.sha;
  if (!/^[0-9a-f]{40}$/i.test(sha ?? ""))
    fail("GitHub main branch returned an invalid SHA");
  return sha.toLowerCase();
}

async function createDraft(api, token, manifest, commit) {
  return jsonRequest(
    `${api}/releases`,
    {
      method: "POST",
      headers: headers(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        tag_name: manifest.tag,
        target_commitish: commit,
        name: manifest.tag,
        body: [
          `Immutable xz-dev Pi distribution ${manifest.distributionVersion}.`,
          "",
          "See README installation instructions and verify assets with SHA256SUMS / GitHub artifact attestations.",
        ].join("\n"),
        draft: true,
        prerelease: false,
      }),
    },
    [201],
  );
}

async function uploadMissingAssets(release, paths, existingAssets, token) {
  for (const path of paths) {
    const name = basename(path);
    if (existingAssets.has(name)) continue;
    await request(
      `${release.upload_url.replace(/\{.*$/, "")}?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: headers(token, { "Content-Type": "application/octet-stream" }),
        body: readFileSync(path),
      },
      [201],
    );
  }
}

async function publishDraft(api, token, release, makeLatest) {
  return jsonRequest(
    `${api}/releases/${release.id}`,
    {
      method: "PATCH",
      headers: headers(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        draft: false,
        prerelease: false,
        make_latest: makeLatest ? "true" : "false",
      }),
    },
    [200],
  );
}

export async function publishGitHubRelease(manifestPath, env = process.env) {
  const repository = requiredEnv("GITHUB_REPOSITORY", env);
  const ref = requiredEnv("GITHUB_REF", env);
  const eventName = requiredEnv("GITHUB_EVENT_NAME", env);
  const commit = requiredEnv("GITHUB_SHA", env).toLowerCase();
  const runNumber = requiredEnv("GITHUB_RUN_NUMBER", env);
  const runAttempt = requiredEnv("GITHUB_RUN_ATTEMPT", env);
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) fail("GITHUB_TOKEN or GH_TOKEN is required");
  if (repository !== EXPECTED_REPOSITORY)
    fail(`Refusing repository ${repository}`);
  if (ref !== EXPECTED_REF) fail(`Refusing ref ${ref}`);
  if (!EXPECTED_EVENT_NAMES.has(eventName)) fail(`Refusing event ${eventName}`);
  if (!/^[0-9a-f]{40}$/i.test(commit))
    fail("GITHUB_SHA must be a full commit SHA");

  const manifest = readManifest(manifestPath);
  const versionMatch = /^(\d+\.\d+\.\d+)-xz\.(\d+)\.(\d+)\.g([0-9a-f]{8})$/.exec(
    manifest.distributionVersion,
  );
  if (
    !versionMatch ||
    versionMatch[2] !== runNumber ||
    versionMatch[3] !== runAttempt ||
    versionMatch[4] !== commit.slice(0, 8)
  ) {
    fail("Manifest distribution version does not match this workflow run attempt");
  }
  if (manifest.commit !== commit)
    fail("Manifest commit does not match GITHUB_SHA");
  const paths = releaseAssetPaths(dirname(manifestPath), manifest);
  const expectedDigests = releaseAssetDigests(paths);
  const api = repositoryApi(repository);

  let release = await getReleaseByTag(api, manifest.tag, token);
  if (release && !release.draft) {
    assertReleaseIdentity(release, manifest.tag, commit);
    await inspectExistingAssets(release, expectedDigests, token, {
      allowSubset: false,
    });
    console.log(
      `Release ${manifest.tag} already exists with identical assets; no changes made`,
    );
    return { created: false, published: false, release };
  }

  if (!release) release = await createDraft(api, token, manifest, commit);
  assertReleaseIdentity(release, manifest.tag, commit);
  const existingAssets = await inspectExistingAssets(
    release,
    expectedDigests,
    token,
    {
      allowSubset: true,
    },
  );
  await uploadMissingAssets(release, paths, existingAssets, token);

  // Re-read the draft and hash every uploaded asset before making it public.
  // Drafts are fetched by id because GitHub's tag endpoint excludes them.
  release = release.draft
    ? await getReleaseById(api, release.id, token)
    : await getReleaseByTag(api, manifest.tag, token);
  if (!release?.draft)
    fail(`Release ${manifest.tag} is not a resumable draft before publication`);
  assertReleaseIdentity(release, manifest.tag, commit);
  await inspectExistingAssets(release, expectedDigests, token, {
    allowSubset: false,
  });

  // Guard latest immediately before the one-way public transition. A delayed or
  // rerun workflow for an older main SHA remains an immutable historical Release.
  const makeLatest = (await mainBranchSha(api, token)) === commit;
  release = await publishDraft(api, token, release, makeLatest);
  if (release.draft || release.prerelease)
    fail(`Release ${manifest.tag} did not publish as final`);
  await inspectExistingAssets(release, expectedDigests, token, {
    allowSubset: false,
  });
  console.log(
    `Published ${manifest.tag} at ${release.html_url} (latest=${makeLatest})`,
  );
  return { created: true, published: true, makeLatest, release };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const [manifestArg, ...extra] = process.argv.slice(2);
  if (!manifestArg || extra.length > 0) fail(usage());
  await publishGitHubRelease(resolve(manifestArg));
}
