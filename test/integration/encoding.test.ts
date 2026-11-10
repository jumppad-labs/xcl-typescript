/** Variables passed in, and entities rendered as configuration text by the real engine. */

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  Attribute,
  Computed,
  createConfig,
  Entity,
  Int,
  LocalRegistry,
  Meta,
  NotEncodableError,
  NotRegisteredError,
  OperationInProgressError,
  Sensitive,
  type Config,
} from "../../src/index.js";
import { isolateHome, missingEngine, missingPlugin, pluginPath, SLOW_PLUGIN, testDirectory, writeConfig } from "../helpers/engine.js";

const needsEngine = missingEngine();
const needsPlugin = needsEngine || missingPlugin(SLOW_PLUGIN);
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

@Entity("never")
class Never {
  @Meta() meta!: Meta;
}

function registry(): LocalRegistry {
  const local = new LocalRegistry();
  local.register(App);
  return local;
}

async function open(t: TestContext, text: string, options: { variables?: Record<string, unknown>; local?: LocalRegistry } = {}): Promise<{ config: Config; path: string; directory: string }> {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", text);
  const config = await createConfig({ registries: [options.local ?? registry()], statePath: join(directory, "state"), ...(options.variables ? { variables: options.variables } : {}) });
  t.after(() => config.close());
  return { config, path, directory };
}

const WEB = `app "web" {
  image    = "nginx"
  password = "s3cret"
}
`;

test("a variable passed in is the value configuration reads", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `variable "region" {
  default = "eu"
}

app "web" {
  image  = "nginx"
  region = variable.region
}
`,
    { variables: { region: "us" } },
  );

  await config.apply(path);

  assert.equal((await config.find(App, "app.web")).region, "us");
});

test("a camelCase variable name reaches its snake_case variable", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `variable "deploy_region" {
  default = "eu"
}

app "web" {
  image  = "nginx"
  region = variable.deploy_region
}
`,
    { variables: { deployRegion: "us" } },
  );

  await config.apply(path);

  assert.equal((await config.find(App, "app.web")).region, "us");
});

test("a looked-up entity encodes as configuration", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(t, WEB);
  await config.apply(path);
  const web = await config.find(App, "app.web");

  const text = await config.encodeEntity(web);

  assert.match(text, /app "web"/);
  assert.match(text, /image\s*=\s*"nginx"/);
  assert.match(text, /password\s*=\s*"\(sensitive\)"/);
});

test("revealSensitive writes the real value", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(t, WEB);
  await config.apply(path);
  const web = await config.find(App, "app.web");

  assert.match(await config.encodeEntity(web, { revealSensitive: true }), /password\s*=\s*"s3cret"/);
});

test("includeComputed writes computed fields", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(t, WEB);
  await config.apply(path);
  const web = await config.find(App, "app.web");

  // the field has no value here, so it is written only with includeEmpty as well
  const withoutComputed = await config.encodeEntity(web, { includeEmpty: true });
  const computed = await config.encodeEntity(web, { includeEmpty: true, includeComputed: true });

  assert.doesNotMatch(withoutComputed, /endpoint/);
  assert.match(computed, /endpoint/);
});

test("includeEmpty writes empty fields", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(t, WEB);
  await config.apply(path);
  const web = await config.find(App, "app.web");

  assert.doesNotMatch(await config.encodeEntity(web), /region/);
  assert.match(await config.encodeEntity(web, { includeEmpty: true }), /region/);
});

test("showReferences writes a reference as configuration wrote it", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `variable "image" {
  default = "nginx"
}

app "web" {
  image = variable.image
}
`,
  );
  await config.apply(path);
  const web = await config.find(App, "app.web");

  assert.match(await config.encodeEntity(web), /image\s*=\s*"nginx"/);
  assert.match(await config.encodeEntity(web, { showReferences: true }), /image\s*=\s*variable\.image/);
});

test("a hand-built entity encodes with its defaults", { skip: needsEngine }, async (t) => {
  const { config } = await open(t, WEB);
  const draft = new App();
  draft.image = "nginx:1.27-alpine";
  draft.meta = { name: "web" };

  const text = await config.encodeEntity(draft);

  assert.match(text, /app "web"/);
  assert.match(text, /image\s*=\s*"nginx:1\.27-alpine"/);
  assert.match(text, /replicas\s*=\s*2/);
});

test("a generic entity encodes as configuration", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(t, WEB);
  await config.apply(path);

  assert.match(await config.encodeEntity(await config.find("app.web")), /image\s*=\s*"nginx"/);
});

test("a saved record encodes as configuration", { skip: needsEngine }, async (t) => {
  const { config } = await open(t, WEB);
  const record = JSON.stringify({ meta: { id: "app.web", name: "web", type: "app" }, image: "nginx" });

  assert.match(await config.encodeSavedEntity(record), /image\s*=\s*"nginx"/);
});

test("a saved record encodes from bytes", { skip: needsEngine }, async (t) => {
  const { config } = await open(t, WEB);
  const record = new TextEncoder().encode(JSON.stringify({ meta: { id: "app.web", name: "web", type: "app" }, image: "nginx" }));

  assert.match(await config.encodeSavedEntity(record, { includeEmpty: true }), /image\s*=\s*"nginx"/);
});

test("a value that is not an entity throws the not-encodable error", { skip: needsEngine }, async (t) => {
  const { config } = await open(t, WEB);

  await assert.rejects(config.encodeEntity("not an entity"), NotEncodableError);
});

test("a variable throws the not-encodable error", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `variable "region" {
  default = "eu"
}
`,
  );
  await config.apply(path);

  await assert.rejects(config.encodeEntity(await config.find("variable.region")), NotEncodableError);
});

test("an output throws the not-encodable error", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `output "value" {
  value = "x"
}
`,
  );
  await config.apply(path);

  await assert.rejects(config.encodeEntity(await config.find("output.value")), NotEncodableError);
});

test("a module throws the not-encodable error", { skip: needsEngine }, async (t) => {
  const { config, directory } = await open(t, WEB);
  const child = join(directory, "child");
  mkdirSync(child);
  writeConfig(child, "main.xcl", 'app "inner" {\n  image = "nginx"\n}\n');
  const parent = join(directory, "parent");
  mkdirSync(parent);
  const path = writeConfig(parent, "main.xcl", `module "child" {\n  source = "../child"\n}\n`);

  await config.apply(path);

  await assert.rejects(config.encodeEntity(await config.find("module.child")), NotEncodableError);
});

test("a value with no configuration form throws the not-encodable error", { skip: needsEngine }, async (t) => {
  const { config } = await open(t, WEB);
  const draft = new App();
  draft.meta = { name: "web" };
  (draft as unknown as { image: unknown }).image = () => "not a value";

  await assert.rejects(config.encodeEntity(draft), NotEncodableError);
});

test("a class never registered throws the not-registered error", { skip: needsEngine }, async (t) => {
  const { config } = await open(t, WEB);
  const entity = new Never();
  entity.meta = { name: "x" };

  await assert.rejects(config.encodeEntity(entity), NotRegisteredError);
});

const SLOW = `resource "slow" "one" {
  delay_ms = 1500
}
`;

function slowRegistry(): LocalRegistry {
  const local = registry();
  local.registerExternalPlugin(pluginPath(SLOW_PLUGIN));
  return local;
}

/** Waits until the engine refuses to encode because an operation is running. */
async function untilRefused(config: Config, draft: App): Promise<unknown> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const result = await config.encodeEntity(draft).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    if (result !== undefined || Date.now() > deadline) {
      return result;
    }
    await delay(10);
  }
}

function draftApp(): App {
  const draft = new App();
  draft.image = "nginx";
  draft.meta = { name: "web" };
  return draft;
}

test("encoding a looked-up entity during an operation throws the operation-in-progress error", { skip: needsPlugin }, async (t) => {
  const { config, path } = await open(t, SLOW, { local: slowRegistry() });

  const applying = config.apply(path);
  const error = await untilRefused(config, draftApp());
  await applying;

  assert.ok(error instanceof OperationInProgressError, `the error was: ${String(error)}`);
});

test("encoding a saved record works during an operation", { skip: needsPlugin }, async (t) => {
  const { config, path } = await open(t, SLOW, { local: slowRegistry() });
  const record = JSON.stringify({ meta: { id: "app.web", name: "web", type: "app" }, image: "nginx" });

  const applying = config.apply(path);
  await untilRefused(config, draftApp());
  const text = await config.encodeSavedEntity(record);
  await applying;

  assert.match(text, /image\s*=\s*"nginx"/);
});
