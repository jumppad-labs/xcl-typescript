/**
 * The plugin release the integration tests install.
 *
 * The plugin is `jumppad-labs/xcl-plugin-test`, a Go binary published as a
 * signed GitHub release, made only for testing. Its `test "item"` block records
 * each operation to a log the configuration names and needs no outside service.
 * It is installed once per test file, through `GitHubRegistry` into a temporary
 * cache, and the tests then start it from that cache entry, by path, by
 * directory, or again through the registry.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { Config, GitHubRegistry, XclError } from "../../src/index.js";
import { ROOT, strict, STRICT_ENV, writeConfig } from "./engine.js";

/** The repository of the plugin release the tests install. */
export const TEST_PLUGIN_REPOSITORY = "jumppad-labs/xcl-plugin-test";

/** The version of the plugin release the tests install. */
export const TEST_PLUGIN_VERSION = "v0.3.1";

/**
 * The long key ID of the jumppad-labs release key, `test/keys/jumppad-labs.asc`,
 * which signs the release's index with its primary key: the issuer of the
 * published `.sig`, as `gpg --list-packets <sig>` prints it.
 */
export const RELEASE_SIGNING_KEY_ID = "F775DA00AFD4B502";

/**
 * An armoured public key that did not sign the release, for the tests that
 * refuse an untrusted key: a throwaway ed25519 key generated with
 * `gpg --quick-generate-key "xcl typescript tests (not the release key)" ed25519 sign never`.
 */
export const UNTRUSTED_KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mDMEavL2XRYJKwYBBAHaRw8BAQdAh1THeJ7LXrv0lD8MmqBJE4IYg1ZzuX9oE2M+
nTv8A3K0KnhjbCB0eXBlc2NyaXB0IHRlc3RzIChub3QgdGhlIHJlbGVhc2Uga2V5
KYiQBBMWCgA4FiEENpxPilcYhaaQariGzUoEROpj/oMFAmry9l0CGwMFCwkIBwIG
FQoJCAsCBBYCAwECHgECF4AACgkQzUoEROpj/oO+IQEAibcA105ZnnMf9GmNX5GK
Lp2JZ9dZo36ovFQ0KzbWxA8BAMRcfLxpjd/dPcNKMhPUIZeHZVuAYUBGN/OGJkdj
N24D
=r08O
-----END PGP PUBLIC KEY BLOCK-----
`;

/** The address of the first of the two items the test configuration declares. */
export const FIRST_ADDRESS = "test.item.first";

/** The address of the second item, which takes the first's output as its input. */
export const SECOND_ADDRESS = "test.item.second";

/** The armoured public key the release is signed with. */
export function trustedKey(): string {
  return readFileSync(join(ROOT, "test", "keys", "jumppad-labs.asc"), "utf8");
}

/** The host as Go names it, GOOS and GOARCH. */
export function goPlatform(): { goos: string; goarch: string } {
  const goos = process.platform === "win32" ? "windows" : process.platform;
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`no plugin build is published for the ${process.arch} architecture`);
  }
  return { goos, goarch: process.arch === "x64" ? "amd64" : "arm64" };
}

/** Where an installed release lives in a cache, and what its files are called. */
export interface ReleaseFiles {
  cacheDir: string;
  /** The directory holding the binary, the release's index, signature and zip, and the zip's other files. */
  entry: string;
  /** The plugin binary. */
  binary: string;
  indexName: string;
  /** The index's path in the entry. */
  index: string;
  signatureName: string;
  /** The signature's path in the entry. */
  signature: string;
  zipName: string;
  /** This platform's zip's path in the entry. */
  zip: string;
}

/**
 * The cache entry of the pinned release under `cacheDir` for this host. The
 * release names its assets with `-` throughout: `<name>-<version>-index.xcl`,
 * its `.sig`, and `<name>-<version>-<os>-<arch>.zip`, where `<version>` has no
 * leading `v`.
 */
export function releaseFiles(cacheDir: string): ReleaseFiles {
  const { goos, goarch } = goPlatform();
  const [owner, name] = TEST_PLUGIN_REPOSITORY.split("/") as [string, string];
  const bareVersion = TEST_PLUGIN_VERSION.replace(/^v/, "");
  const entry = join(cacheDir, "github.com", owner, name, TEST_PLUGIN_VERSION, `${goos}_${goarch}`);
  const indexName = `${name}-${bareVersion}-index.xcl`;
  const signatureName = `${indexName}.sig`;
  const zipName = `${name}-${bareVersion}-${goos}-${goarch}.zip`;
  return {
    cacheDir,
    entry,
    binary: join(entry, name + (goos === "windows" ? ".exe" : "")),
    indexName,
    index: join(entry, indexName),
    signatureName,
    signature: join(entry, signatureName),
    zipName,
    zip: join(entry, zipName),
  };
}

/** A registry installing the pinned release into `cacheDir`. */
export function githubRegistry(cacheDir: string, options: { trustedKeys: readonly string[]; apiUrl?: string }): GitHubRegistry {
  const registry = new GitHubRegistry({ cacheDir, trustedKeys: options.trustedKeys, ...(options.apiUrl !== undefined ? { apiUrl: options.apiUrl } : {}) });
  registry.registerPlugin(TEST_PLUGIN_REPOSITORY, TEST_PLUGIN_VERSION);
  return registry;
}

/**
 * Writes the configuration of two items to `directory`, the items recording to
 * `log`, and returns its path. `second` takes `first`'s output as its input, so
 * it is created after `first` and destroyed before it. `first` is declared on
 * line 1 and `second` on line 7, which the tests rely on.
 */
export function writeTestPluginConfig(directory: string, log: string): string {
  const quotedLog = JSON.stringify(log);
  return writeConfig(
    directory,
    "main.xcl",
    `test "item" "first" {
  log    = ${quotedLog}
  value  = "one"
  secret = "hunter2"
}

test "item" "second" {
  log   = ${quotedLog}
  value = "two"
  input = test.item.first.output
}
`,
  );
}

/** The operations the items recorded to the log at `path`, in order. */
export function readOperations(path: string): { operation: string; address: string }[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { operation: string; address: string });
}

let installation: Promise<{ release: ReleaseFiles } | { failure: string }> | undefined;

/**
 * Validates the configuration once, which installs and verifies the release
 * into `cacheDir`, and remembers the outcome. A release that cannot be
 * installed (no network, or no such release) skips the test, and throws in a
 * strict run.
 */
export async function installedRelease(t: TestContext, cacheDir: string): Promise<ReleaseFiles | undefined> {
  installation ??= install(cacheDir);
  const outcome = await installation;
  if ("failure" in outcome) {
    if (strict()) {
      throw new Error(`${outcome.failure} (${STRICT_ENV}=1 turns this skip into a failure)`);
    }
    t.skip(outcome.failure);
    return undefined;
  }
  return outcome.release;
}

async function install(cacheDir: string): Promise<{ release: ReleaseFiles } | { failure: string }> {
  const directory = join(cacheDir, "install");
  const configPath = writeTestPluginConfig(directory, join(directory, "ops.jsonl"));
  try {
    await using config = await new Config({
      registries: [githubRegistry(cacheDir, { trustedKeys: [trustedKey()] })],
      statePath: join(directory, "state"),
    }).setup();
    await config.validate(configPath);
  } catch (error) {
    if (error instanceof XclError) {
      return { failure: `the plugin release ${TEST_PLUGIN_REPOSITORY} ${TEST_PLUGIN_VERSION} could not be installed from GitHub: ${error.message}` };
    }
    throw error;
  }
  return { release: releaseFiles(cacheDir) };
}
