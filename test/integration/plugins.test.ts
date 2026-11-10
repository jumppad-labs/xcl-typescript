/**
 * Go plugins are usable from TypeScript: the test plugin, end to end.
 *
 * The plugin is installed once per file from its signed GitHub release and then
 * started three ways: through the GitHub registry again, from its binary's path,
 * and from the directory the binary is in. Each test applies two items where
 * `second` takes `first`'s output as its input, reads them back as generic
 * entities, and destroys what it created.
 */

import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { createConfig, LocalRegistry } from "../../src/index.js";
import type { Entity } from "../../src/index.js";
import { isolateHome, missingEngine, sharedDirectory, testDirectory } from "../helpers/engine.js";
import {
  FIRST_ADDRESS,
  githubRegistry,
  installedRelease,
  readOperations,
  SECOND_ADDRESS,
  trustedKey,
  writeTestPluginConfig,
  type ReleaseFiles,
} from "../helpers/plugins.js";

const skip = missingEngine();
isolateHome();
const cache = sharedDirectory();

/** A registry starting the installed plugin from its binary's path. */
function pathRegistry(release: ReleaseFiles): LocalRegistry {
  const registry = new LocalRegistry();
  registry.registerExternalPlugin(release.binary);
  return registry;
}

/** The two items as the configuration declares them, with their computed outputs. */
function assertItems(first: Entity, second: Entity): void {
  assert.equal(first.meta.id, FIRST_ADDRESS);
  assert.equal(first.attributes.value, "one");
  assert.equal(first.attributes.output, "first-one");

  assert.equal(second.meta.id, SECOND_ADDRESS);
  assert.equal(second.attributes.input, "first-one");
  assert.equal(second.attributes.output, "second-two");
}

function configPathFor(t: TestContext): { configPath: string; directory: string } {
  const directory = testDirectory(t);
  return { configPath: writeTestPluginConfig(directory, join(directory, "ops.jsonl")), directory };
}

test("the test plugin applies from the GitHub registry", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const { configPath, directory } = configPathFor(t);

  await using config = await createConfig({
    registries: [githubRegistry(release.cacheDir, { trustedKeys: [trustedKey()] })],
    statePath: join(directory, "state"),
  });
  await config.apply(configPath);
  const applied = await config.findByType("test", "item");
  const first = await config.find(FIRST_ADDRESS);
  const second = await config.find(SECOND_ADDRESS);
  await config.destroy();
  const remaining = await config.findByType("test", "item");

  assert.deepEqual(applied.map((entity) => entity.meta.id).sort(), [FIRST_ADDRESS, SECOND_ADDRESS]);
  assertItems(first, second);
  assert.deepEqual(remaining, []);
});

test("the test plugin applies from its binary's path", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const { configPath, directory } = configPathFor(t);

  await using config = await createConfig({ registries: [pathRegistry(release)], statePath: join(directory, "state") });
  await config.apply(configPath);
  const first = await config.find(FIRST_ADDRESS);
  const second = await config.find(SECOND_ADDRESS);
  await config.destroy();
  const remaining = await config.findByType("test", "item");

  assertItems(first, second);
  assert.deepEqual(remaining, []);
});

test("the test plugin applies from the directory it is in", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  // the cache entry holds the binary beside the release's index, signature and
  // zip, which are not executable, and the other files the zip held, so the
  // default xcl-plugin-* pattern starts only the binary
  if (process.platform !== "win32") {
    const executables = readdirSync(release.entry).filter((name) => (statSync(join(release.entry, name)).mode & 0o111) !== 0);
    assert.deepEqual(executables, ["xcl-plugin-test"]);
  }
  const { configPath, directory } = configPathFor(t);

  const registry = new LocalRegistry();
  registry.registerPluginDirectory(release.entry);
  await using config = await createConfig({ registries: [registry], statePath: join(directory, "state") });
  await config.apply(configPath);
  const first = await config.find(FIRST_ADDRESS);
  const second = await config.find(SECOND_ADDRESS);
  await config.destroy();
  const remaining = await config.findByType("test", "item");

  assertItems(first, second);
  assert.deepEqual(remaining, []);
});

test("plugin entities read back as generic entities", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const { configPath, directory } = configPathFor(t);

  await using config = await createConfig({ registries: [pathRegistry(release)], statePath: join(directory, "state") });
  await config.apply(configPath);
  const first = await config.find(FIRST_ADDRESS);
  const second = await config.find(SECOND_ADDRESS);
  await config.destroy();

  assert.equal(first.meta.name, "first");
  assert.equal(first.meta.type, "test");
  assert.equal(first.meta.subtype, "item");
  assert.equal(first.meta.file, configPath);
  assert.equal(first.meta.line, 1);
  assert.equal(first.meta.status, "created");
  assert.equal(first.attributes.value, "one");

  assert.equal(second.meta.line, 7);
  assert.equal(second.meta.type, "test");
  assert.equal(second.meta.subtype, "item");
  assert.equal(second.meta.references?.input, `${FIRST_ADDRESS}.output`);
  assert.ok(second.meta.links?.includes(`${FIRST_ADDRESS}.output`), `links were: ${JSON.stringify(second.meta.links)}`);
});

test("items are created and destroyed in dependency order", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const { configPath, directory } = configPathFor(t);

  await using config = await createConfig({ registries: [pathRegistry(release)], statePath: join(directory, "state") });
  await config.apply(configPath);
  await config.destroy();

  // first and second are linked through input, so the graph fixes their order
  const operations = readOperations(join(directory, "ops.jsonl"));
  const creates = operations.filter((record) => record.operation === "create").map((record) => record.address);
  const destroys = operations.filter((record) => record.operation === "destroy").map((record) => record.address);
  assert.deepEqual(creates, [FIRST_ADDRESS, SECOND_ADDRESS]);
  assert.deepEqual(destroys, [SECOND_ADDRESS, FIRST_ADDRESS]);
});

test("a sensitive setting is redacted in a lookup", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const { configPath, directory } = configPathFor(t);

  await using config = await createConfig({ registries: [pathRegistry(release)], statePath: join(directory, "state") });
  await config.apply(configPath);
  const first = await config.find(FIRST_ADDRESS);
  await config.destroy();

  // a generic entity has no type to rebuild a sensitive value from, so the
  // redacted value reads back as the marker
  assert.equal(first.attributes.secret, "(sensitive)");
  assert.ok(!JSON.stringify(first).includes("hunter2"));
});
