/** Entities, change summaries and reports printed through the real engine. */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { Attribute, Computed, createConfig, Entity, formatError, Int, LocalRegistry, Meta, printDiff, Sensitive, type Config, type Formatter, type Token } from "../../src/index.js";
import { isolateHome, missingEngine, missingPlugin, pluginPath, SLOW_PLUGIN, testDirectory, writeConfig } from "../helpers/engine.js";

const skip = missingEngine();
const needsPlugin = skip || missingPlugin(SLOW_PLUGIN);
isolateHome();

@Entity("app")
class App {
  @Meta() meta!: Meta;
  @Attribute(String) image!: string;
  @Attribute(Int) replicas = 2;
  @Sensitive(String, { optional: true }) password?: Sensitive<string>;
  @Computed(String) endpoint?: string;
  @Attribute(String, { optional: true }) region?: string;
}

const REFERENCED = `variable "image" {
  default = "nginx"
}

app "web" {
  image    = variable.image
  password = "s3cret"
}
`;

/** Go's text for the entity under each choice, as the engine renders it. */
/** Go's change summary for one resource to create. */
const DIFF_EXPECTED = '  # resource.slow.one will be created\n  + resource "slow" "one" {\n      + delay_ms = 1\n    }\n\nDiff: 1 to create, 0 to update, 0 to replace, 0 to delete, 0 unchanged.\n';

const EXPECTED = {
  none: 'app "web" {\n  image    = "nginx"\n  replicas = 2\n  password = "(sensitive)"\n}\n',
  computed: 'app "web" {\n  image    = "nginx"\n  replicas = 2\n  password = "(sensitive)"\n}\n',
  empty: 'app "web" {\n  image    = "nginx"\n  replicas = 2\n  password = "(sensitive)"\n  region   = ""\n}\n',
  reveal: 'app "web" {\n  image    = "nginx"\n  replicas = 2\n  password = "s3cret"\n}\n',
  references: 'app "web" {\n  image    = variable.image\n  replicas = 2\n  password = "(sensitive)"\n}\n',
  all: 'app "web" {\n  image    = variable.image\n  replicas = 2\n  password = "s3cret"\n  endpoint = "" # set by the provider\n  region   = ""\n}\n',
};

async function applied(t: TestContext, text: string): Promise<{ config: Config; path: string }> {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", text);
  const local = new LocalRegistry();
  local.register(App);
  const config = await createConfig({ registries: [local], statePath: join(directory, "state") });
  t.after(() => config.close());
  await config.apply(path);
  return { config, path };
}

/** What `printEntity` writes with `options`. */
async function printed(config: Config, options: object): Promise<string> {
  const web = await config.find(App, "app.web");
  let text = "";
  await config.printEntity(web, { ...options, out: { write: (chunk) => (text += chunk) } });
  return text;
}

test("printing an entity with no choices gives Go's text", { skip }, async (t) => {
  const { config } = await applied(t, REFERENCED);
  assert.equal(await printed(config, {}), EXPECTED.none);
});

test("printing an entity with computed fields gives Go's text", { skip }, async (t) => {
  const { config } = await applied(t, REFERENCED);
  assert.equal(await printed(config, { includeComputed: true }), EXPECTED.computed);
});

test("printing an entity with empty fields gives Go's text", { skip }, async (t) => {
  const { config } = await applied(t, REFERENCED);
  assert.equal(await printed(config, { includeEmpty: true }), EXPECTED.empty);
});

test("printing an entity revealing sensitive values gives Go's text", { skip }, async (t) => {
  const { config } = await applied(t, REFERENCED);
  assert.equal(await printed(config, { revealSensitive: true }), EXPECTED.reveal);
});

test("printing an entity showing references gives Go's text", { skip }, async (t) => {
  const { config } = await applied(t, REFERENCED);
  assert.equal(await printed(config, { showReferences: true }), EXPECTED.references);
});

test("printing an entity with all four choices gives Go's text", { skip }, async (t) => {
  const { config } = await applied(t, REFERENCED);
  assert.equal(await printed(config, { includeComputed: true, includeEmpty: true, revealSensitive: true, showReferences: true }), EXPECTED.all);
});

test("an entity's labelled text joins to the text encodeEntity gives", { skip }, async (t) => {
  const { config } = await applied(t, REFERENCED);
  const web = await config.find(App, "app.web");
  const tokens = await config.entityTokens(web, { includeComputed: true });
  assert.equal(tokens.map((token) => token.text).join(""), await config.encodeEntity(web, { includeComputed: true }));
});

test("each part of an entity's labelled text carries its kind", { skip }, async (t) => {
  const { config } = await applied(t, REFERENCED);
  const web = await config.find(App, "app.web");
  const tokens = await config.entityTokens(web);
  assert.ok(tokens.every((token) => Number.isInteger(token.kind)));
  assert.ok(tokens.some((token) => token.kind !== 0));
});

test("a user's format receives an entity's whole text in one call", { skip }, async (t) => {
  const { config } = await applied(t, REFERENCED);
  const web = await config.find(App, "app.web");
  const calls: (readonly Token[])[] = [];
  const recording: Formatter = (out, _theme, tokens) => {
    calls.push(tokens);
    out.write("recorded");
  };
  let text = "";
  await config.printEntity(web, { formatter: recording, out: { write: (chunk) => (text += chunk) } });
  assert.equal(calls.length, 1);
  assert.equal(text, "recorded");
});

test("a change summary with nothing to do gives Go's text", { skip }, async (t) => {
  const { config, path } = await applied(t, 'app "web" {\n  image = "nginx"\n}\n');
  const diff = await config.diff(path);
  let text = "";
  printDiff(diff, { out: { write: (chunk) => (text += chunk) } });
  assert.equal(text, "Diff: no changes, 0 unchanged.\n");
});

test("a change summary gives Go's text and its labelled text joins to it", { skip: needsPlugin }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", 'resource "slow" "one" {\n  delay_ms = 1\n}\n');
  const local = new LocalRegistry();
  local.registerExternalPlugin(pluginPath(SLOW_PLUGIN));
  const config = await createConfig({ registries: [local], statePath: join(directory, "state") });
  t.after(() => config.close());
  const diff = await config.diff(path);
  let text = "";
  printDiff(diff, { out: { write: (chunk) => (text += chunk) } });
  assert.equal(diff.tokens.map((token) => token.text).join(""), text);
  assert.equal(text, DIFF_EXPECTED);
});

test("a user's format receives a change summary's whole text in one call", { skip: needsPlugin }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", 'resource "slow" "one" {\n  delay_ms = 1\n}\n');
  const local = new LocalRegistry();
  local.registerExternalPlugin(pluginPath(SLOW_PLUGIN));
  const config = await createConfig({ registries: [local], statePath: join(directory, "state") });
  t.after(() => config.close());
  const diff = await config.diff(path);
  const calls: (readonly Token[])[] = [];
  const recording: Formatter = (_out, _theme, tokens) => {
    calls.push(tokens);
  };
  printDiff(diff, { formatter: recording, out: { write: () => undefined } });
  assert.deepEqual(calls, [diff.tokens]);
});

test("a report's labelled text joins to its plain text", { skip }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", 'app "web" {\n  image = "nginx"\n  nope {\n  }\n}\n');
  const local = new LocalRegistry();
  local.register(App);
  const config = await createConfig({ registries: [local], statePath: join(directory, "state") });
  t.after(() => config.close());
  const error = await config.validate(path).catch((caught: unknown) => caught);
  assert.equal((error as { tokens: Token[] }).tokens.map((token) => token.text).join(""), formatError(error, { width: 0 }));
});
