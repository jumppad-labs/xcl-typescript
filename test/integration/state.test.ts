/**
 * State in a directory and in a store written in TypeScript, and sensitive
 * values masked in it. A load runs in a fresh process, so it can only read what
 * was saved.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { Attribute, Config, Entity, type Event, EventDataLevel, LocalRegistry, Meta, Sensitive, type StateStore } from "../../src/index.js";
import { aes256gcm } from "../../src/mask.js";
import { isolateHome, missingEngine, testDirectory, writeConfig } from "../helpers/engine.js";
import { missingBuild, runScenario, SDK_MODULE } from "../helpers/script.js";

const needsEngine = missingEngine() || missingBuild();
isolateHome();

@Entity("app")
class App {
  @Meta() meta!: Meta;
  @Attribute(String) image!: string;
  @Sensitive(String, { optional: true }) password?: Sensitive<string>;
}

const TEXT = `app "web" {
  image    = "nginx"
  password = "s3cret"
}
`;

// the scenarios are plain JavaScript, so they call the decorators in their legacy form
const SCENARIO_APP = `import { Attribute, Config, Entity, LocalRegistry, Meta, Sensitive } from ${JSON.stringify(SDK_MODULE)};
class App {
  meta;
  image;
  password;
}
Meta()(App.prototype, "meta");
Attribute(String)(App.prototype, "image");
Sensitive(String, { optional: true })(App.prototype, "password");
Entity("app")(App);
const local = new LocalRegistry();
local.register(App);`;

function registry(): LocalRegistry {
  const local = new LocalRegistry();
  local.register(App);
  return local;
}

/** A store keeping its records in memory, with every method asynchronous. */
class MemoryStore implements StateStore {
  records: Uint8Array[] = [];
  saved = false;

  async load(): Promise<Uint8Array[]> {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return this.records;
  }

  async save(records: Uint8Array[]): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.records = records;
    this.saved = true;
  }

  async exists(): Promise<boolean> {
    return this.saved;
  }

  async clear(): Promise<void> {
    this.records = [];
    this.saved = false;
  }
}

function recordFor(records: Uint8Array[], id: string): Record<string, unknown> {
  const found = records.map((record) => JSON.parse(new TextDecoder().decode(record)) as Record<string, unknown>).find((record) => (record.meta as { id: string }).id === id);
  assert.ok(found, `no record for ${id}`);
  return found;
}

function savedState(directory: string): { meta: { id: string }; image: string; password: unknown }[] {
  return JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as { meta: { id: string }; image: string; password: unknown }[];
}

test("a store with async methods receives the state on apply", { skip: needsEngine }, async (t) => {
  const path = writeConfig(testDirectory(t), "main.xcl", TEXT);
  const store = new MemoryStore();
  await using config = await new Config({ registries: [registry()], stateStore: store }).setup();

  await config.apply(path);

  assert.equal(recordFor(store.records, "app.web").image, "nginx");
});

test("a later load in a new process reads a custom store back", { skip: needsEngine }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", TEXT);
  const store = new MemoryStore();
  {
    await using config = await new Config({ registries: [registry()], stateStore: store }).setup();
    await config.apply(path);
  }
  const saved = Buffer.from(JSON.stringify(store.records.map((record) => Buffer.from(record).toString("base64")))).toString("base64");

  const script = await runScenario(
    `${SCENARIO_APP}
const records = JSON.parse(Buffer.from(${JSON.stringify(saved)}, "base64").toString()).map((record) => new Uint8Array(Buffer.from(record, "base64")));
const store = { load: async () => records, save: async () => {}, exists: async () => true, clear: async () => {} };
const config = await new Config({ registries: [local], stateStore: store }).setup();
await config.load();
const web = await config.find(App, "app.web");
console.log("image:" + web.image);
await config.close();
`,
    directory,
  );

  assert.equal(script.exitCode, 0, script.stderr);
  assert.equal(script.values("image:")[0], "nginx");
});

test("a state directory is written by an apply and read back by a load in a new process", { skip: needsEngine }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", TEXT);
  const state = join(directory, "state");
  {
    await using config = await new Config({ registries: [registry()], statePath: state }).setup();
    await config.apply(path);
  }

  assert.equal(savedState(state).find((record) => record.meta.id === "app.web")?.image, "nginx");
  const script = await runScenario(
    `${SCENARIO_APP}
const config = await new Config({ registries: [local], statePath: ${JSON.stringify(state)} }).setup();
await config.load();
const web = await config.find(App, "app.web");
console.log("image:" + web.image);
await config.close();
`,
    directory,
  );

  assert.equal(script.exitCode, 0, script.stderr);
  assert.equal(script.values("image:")[0], "nginx");
});

test("with encryption enabled, sensitive values in what the store receives are encrypted", { skip: needsEngine }, async (t) => {
  const path = writeConfig(testDirectory(t), "main.xcl", TEXT);
  const store = new MemoryStore();
  await using config = await new Config({ registries: [registry()], stateStore: store, stateMask: aes256gcm(new Uint8Array(32).fill(1)) }).setup();

  await config.apply(path);

  const password = recordFor(store.records, "app.web").password;
  assert.equal(typeof password, "object");
  assert.ok("xcl_masked" in (password as object), JSON.stringify(password));
  assert.doesNotMatch(new TextDecoder().decode(store.records[0]), /s3cret/);
});

test("a store's exception fails the operation with its message", { skip: needsEngine }, async (t) => {
  const path = writeConfig(testDirectory(t), "main.xcl", TEXT);
  const store = new MemoryStore();
  store.save = async () => {
    throw new Error("the disk is full");
  };
  await using config = await new Config({ registries: [registry()], stateStore: store }).setup();

  await assert.rejects(config.apply(path), /the disk is full/);
});

test("a sensitive value is masked in state when a state mask is set", { skip: needsEngine }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", TEXT);
  const state = join(directory, "state");
  await using config = await new Config({ registries: [registry()], statePath: state, stateMask: aes256gcm(new Uint8Array(32).fill(2)) }).setup();

  await config.apply(path);

  const password = savedState(state).find((record) => record.meta.id === "app.web")?.password;
  assert.equal(typeof password, "object");
  assert.ok("xcl_masked" in (password as object), JSON.stringify(password));
});

test("a sensitive value is masked in events when a state mask is set", { skip: needsEngine }, async (t) => {
  const path = writeConfig(testDirectory(t), "main.xcl", TEXT);
  const events: Event[] = [];
  await using config = await new Config({
    registries: [registry()],
    statePath: join(testDirectory(t), "state"),
    stateMask: aes256gcm(new Uint8Array(32).fill(3)),
    eventData: EventDataLevel.Processed,
    onEvent: (event) => {
      events.push(event);
    },
  }).setup();

  await config.apply(path);

  const data = events.find((event) => event.resourceId === "app.web" && event.operation === "create" && event.phase === "success")?.data;
  assert.ok(data, "the create success event carried no data");
  assert.match(new TextDecoder().decode(data), /"image":"nginx"/);
  assert.doesNotMatch(new TextDecoder().decode(data), /s3cret/);
});
