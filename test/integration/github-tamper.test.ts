/**
 * A plugin release that fails verification is refused, through the TypeScript
 * API, against the real engine.
 *
 * A fake GitHub API answers the two routes the engine reads, from the real files
 * of the test plugin release installed once per file: its index, the index's
 * signature and this platform's zip. Serving them unaltered is the positive
 * control; altering the index or the zip, or trusting a key other than the
 * release key, must be refused with `PluginVerificationError` before the plugin
 * is ever started.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { Config, PluginVerificationError, XclError } from "../../src/index.js";
import { isolateHome, missingEngine, sharedDirectory, testDirectory } from "../helpers/engine.js";
import { FakeGitHub, type ReleaseAsset } from "../helpers/fake-github.js";
import {
  FIRST_ADDRESS,
  githubRegistry,
  goPlatform,
  installedRelease,
  RELEASE_SIGNING_KEY_ID,
  releaseFiles,
  TEST_PLUGIN_REPOSITORY,
  TEST_PLUGIN_VERSION,
  trustedKey,
  UNTRUSTED_KEY,
  writeTestPluginConfig,
  type ReleaseFiles,
} from "../helpers/plugins.js";

const skip = missingEngine();
isolateHome();
const cache = sharedDirectory();

/** The release's index, signature and this platform's zip, as installed. */
function realAssets(release: ReleaseFiles): ReleaseAsset[] {
  return [
    [release.indexName, readFileSync(release.index)],
    [release.signatureName, readFileSync(release.signature)],
    [release.zipName, readFileSync(release.zip)],
  ];
}

/** `assets` with the asset named `name` replaced by `data`. */
function replaced(assets: readonly ReleaseAsset[], name: string, data: Uint8Array): ReleaseAsset[] {
  return assets.map(([assetName, assetData]) => [assetName, assetName === name ? data : assetData]);
}

/**
 * The real index with the last hex digit of this platform's zip checksum
 * changed. The checksum line follows the line naming the zip's asset, inside the
 * platform's block.
 */
function tamperedIndex(release: ReleaseFiles): Uint8Array {
  const lines = readFileSync(release.index, "utf8").split("\n");
  const asset = lines.findIndex((line) => line.includes(`"${release.zipName}"`));
  assert.ok(asset !== -1, `the index does not name ${release.zipName}`);

  let checksum = asset + 1;
  while (!(lines[checksum] as string).includes("checksum")) {
    checksum += 1;
  }
  const line = lines[checksum] as string;
  assert.ok(line.endsWith('"'), `the checksum line was: ${line}`);
  const digit = line.at(-2);
  lines[checksum] = line.slice(0, -2) + (digit === "0" ? "1" : "0") + '"';
  return Buffer.from(lines.join("\n"), "utf8");
}

/** The real zip with one byte in its middle changed. */
function tamperedZip(release: ReleaseFiles): Uint8Array {
  const data = Buffer.from(readFileSync(release.zip));
  const middle = Math.floor(data.length / 2);
  data[middle] = (data[middle] as number) ^ 0xff;
  return data;
}

test("a release whose index was altered is refused with a signature error", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const directory = testDirectory(t);
  const assets = replaced(realAssets(release), release.indexName, tamperedIndex(release));
  const fake = await FakeGitHub.start(TEST_PLUGIN_REPOSITORY, TEST_PLUGIN_VERSION, assets);
  t.after(() => fake.close());
  const cacheDir = join(directory, "cache");
  const configPath = writeTestPluginConfig(directory, join(directory, "ops.jsonl"));

  await using config = await new Config({
    registries: [githubRegistry(cacheDir, { trustedKeys: [trustedKey()], apiUrl: fake.url })],
    statePath: join(directory, "state"),
  }).setup();
  const error = await config.validate(configPath).then(
    () => undefined,
    (reason: unknown) => reason,
  );

  const { goos, goarch } = goPlatform();
  assert.ok(error instanceof PluginVerificationError, `the error was: ${String(error)}`);
  assert.ok(error instanceof XclError);
  assert.equal(error.code, "plugin_verification");
  assert.equal(error.details.repository, TEST_PLUGIN_REPOSITORY);
  assert.equal(error.details.version, TEST_PLUGIN_VERSION);
  assert.equal(error.details.platform, `${goos}/${goarch}`);
  assert.ok(error.message.includes(release.signatureName), error.message);
  assert.ok(error.message.includes("does not verify against any trusted key"), error.message);
  // the release, the index and its signature are read, and the signature check
  // fails before the zip is downloaded
  assert.equal(fake.requests[0], fake.releasePath);
  assert.equal(fake.requests.length, 3, JSON.stringify(fake.requests));
  assert.ok(!fake.requests.includes(fake.assetPath(fake.assetId(release.zipName))));
  assert.ok(!existsSync(releaseFiles(cacheDir).entry), "a refused release must not be cached");
});

test("a release whose zip was altered is refused by its checksum", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const directory = testDirectory(t);
  const assets = replaced(realAssets(release), release.zipName, tamperedZip(release));
  const fake = await FakeGitHub.start(TEST_PLUGIN_REPOSITORY, TEST_PLUGIN_VERSION, assets);
  t.after(() => fake.close());
  const cacheDir = join(directory, "cache");
  const configPath = writeTestPluginConfig(directory, join(directory, "ops.jsonl"));

  await using config = await new Config({
    registries: [githubRegistry(cacheDir, { trustedKeys: [trustedKey()], apiUrl: fake.url })],
    statePath: join(directory, "state"),
  }).setup();
  const error = await config.validate(configPath).then(
    () => undefined,
    (reason: unknown) => reason,
  );

  const { goos, goarch } = goPlatform();
  assert.ok(error instanceof PluginVerificationError, `the error was: ${String(error)}`);
  assert.ok(error instanceof XclError);
  assert.equal(error.code, "plugin_verification");
  assert.equal(error.details.repository, TEST_PLUGIN_REPOSITORY);
  assert.equal(error.details.version, TEST_PLUGIN_VERSION);
  assert.equal(error.details.platform, `${goos}/${goarch}`);
  assert.ok(error.message.includes(`zip ${release.zipName} does not match its checksum in the index`), error.message);
  assert.equal(fake.requests[0], fake.releasePath);
  assert.equal(fake.requests.length, 4, JSON.stringify(fake.requests));
  assert.ok(!existsSync(releaseFiles(cacheDir).entry), "a refused release must not be cached");
});

test("a release signed by an untrusted key is refused", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const directory = testDirectory(t);
  const fake = await FakeGitHub.start(TEST_PLUGIN_REPOSITORY, TEST_PLUGIN_VERSION, realAssets(release));
  t.after(() => fake.close());
  const cacheDir = join(directory, "cache");
  const configPath = writeTestPluginConfig(directory, join(directory, "ops.jsonl"));

  await using config = await new Config({
    registries: [githubRegistry(cacheDir, { trustedKeys: [UNTRUSTED_KEY], apiUrl: fake.url })],
    statePath: join(directory, "state"),
  }).setup();
  const error = await config.validate(configPath).then(
    () => undefined,
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof PluginVerificationError, `the error was: ${String(error)}`);
  assert.ok(error instanceof XclError);
  assert.equal(error.code, "plugin_verification");
  assert.equal(error.details.repository, TEST_PLUGIN_REPOSITORY);
  assert.ok(error.message.includes("does not verify against any trusted key"), error.message);
  assert.ok(!existsSync(releaseFiles(cacheDir).entry), "a refused release must not be cached");
});

test("the refusal of an untrusted key names the key that signed the release", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const directory = testDirectory(t);
  const fake = await FakeGitHub.start(TEST_PLUGIN_REPOSITORY, TEST_PLUGIN_VERSION, realAssets(release));
  t.after(() => fake.close());
  const configPath = writeTestPluginConfig(directory, join(directory, "ops.jsonl"));

  await using config = await new Config({
    registries: [githubRegistry(join(directory, "cache"), { trustedKeys: [UNTRUSTED_KEY], apiUrl: fake.url })],
    statePath: join(directory, "state"),
  }).setup();
  const error = await config.validate(configPath).then(
    () => undefined,
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof PluginVerificationError, `the error was: ${String(error)}`);
  assert.ok(error.message.includes(`signed by key ${RELEASE_SIGNING_KEY_ID}, which is not trusted`), error.message);
});

test("a release without a signature installs when no keys are trusted", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const directory = testDirectory(t);
  // the engine checks signatures only when keys are trusted
  const assets = realAssets(release).filter(([name]) => name !== release.signatureName);
  const fake = await FakeGitHub.start(TEST_PLUGIN_REPOSITORY, TEST_PLUGIN_VERSION, assets);
  t.after(() => fake.close());
  const cacheDir = join(directory, "cache");
  const configPath = writeTestPluginConfig(directory, join(directory, "ops.jsonl"));

  await using config = await new Config({
    registries: [githubRegistry(cacheDir, { trustedKeys: [], apiUrl: fake.url })],
    statePath: join(directory, "state"),
  }).setup();
  await config.validate(configPath);

  const installed = releaseFiles(cacheDir);
  assert.ok(existsSync(installed.binary));
  assert.ok(existsSync(installed.index));
  assert.ok(existsSync(installed.zip));
  assert.ok(!existsSync(installed.signature));
  assert.equal(fake.requests[0], fake.releasePath);
});

test("the fake API serving the real release installs it", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const directory = testDirectory(t);
  const fake = await FakeGitHub.start(TEST_PLUGIN_REPOSITORY, TEST_PLUGIN_VERSION, realAssets(release));
  t.after(() => fake.close());
  const cacheDir = join(directory, "cache");
  const configPath = writeTestPluginConfig(directory, join(directory, "ops.jsonl"));

  await using config = await new Config({
    registries: [githubRegistry(cacheDir, { trustedKeys: [trustedKey()], apiUrl: fake.url })],
    statePath: join(directory, "state"),
  }).setup();
  await config.apply(configPath);
  const first = await config.find(FIRST_ADDRESS);
  await config.destroy();
  const remaining = await config.entityCount();

  const installed = releaseFiles(cacheDir);
  assert.deepEqual(readFileSync(installed.binary), readFileSync(release.binary));
  assert.ok(existsSync(installed.signature));
  assert.equal(fake.requests[0], fake.releasePath);
  assert.deepEqual(fake.requests.slice(1).sort(), [fake.assetPath(1), fake.assetPath(2), fake.assetPath(3)].sort());
  assert.equal(first.attributes.output, "first-one");
  assert.equal(remaining, 0);
});
