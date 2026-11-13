/** The engine's events delivered to a TypeScript handler. */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { Attribute, Config, Entity, type Event, EventDataLevel, LocalRegistry, Meta, Sensitive } from "../../src/index.js";
import { isolateHome, missingEngine, missingPlugin, pluginPath, SLOW_PLUGIN, testDirectory, writeConfig } from "../helpers/engine.js";

const needsPlugin = missingEngine() || missingPlugin(SLOW_PLUGIN);
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

resource "slow" "one" {
  delay_ms = 5
}

resource "slow" "two" {
  delay_ms = 5
}
`;

async function applied(t: TestContext, eventData: EventDataLevel | undefined, onEvent: (event: Event, config: Config) => void | Promise<void> = () => {}): Promise<{ config: Config; events: Event[] }> {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", TEXT);
  const local = new LocalRegistry();
  local.register(App);
  local.registerExternalPlugin(pluginPath(SLOW_PLUGIN));
  const events: Event[] = [];
  let created: Config | undefined;
  const config = await new Config({
    registries: [local],
    statePath: join(directory, "state"),
    ...(eventData === undefined ? {} : { eventData }),
    onEvent: (event) => {
      events.push(event);
      return onEvent(event, created as Config);
    },
  }).setup();
  created = config;
  t.after(() => config.close());
  await config.apply(path);
  return { config, events };
}

function successOf(events: Event[], resourceId: string): Event | undefined {
  return events.find((event) => event.resourceId === resourceId && event.operation === "create" && event.phase === "success");
}

test("a handler receives an event for each entity's start and finish during an apply", { skip: needsPlugin }, async (t) => {
  const { events } = await applied(t, undefined);

  const phases = (resourceId: string): string[] => events.filter((event) => event.resourceId === resourceId && event.operation === "create").map((event) => event.phase);

  assert.deepEqual(phases("resource.slow.one"), ["start", "success"]);
  assert.deepEqual(phases("resource.slow.two"), ["start", "success"]);
});

test("at the no-data level events carry no entity data", { skip: needsPlugin }, async (t) => {
  const { events } = await applied(t, EventDataLevel.None);

  assert.ok(events.length > 0);
  assert.ok(events.every((event) => event.data === undefined));
});

test("at the raw level events carry entity data with sensitive values redacted", { skip: needsPlugin }, async (t) => {
  const { events } = await applied(t, EventDataLevel.Raw);

  const text = new TextDecoder().decode(successOf(events, "app.web")?.data);

  assert.match(text, /"image":"nginx"/);
  assert.doesNotMatch(text, /s3cret/);
});

test("at the processed level events carry entity data with sensitive values redacted", { skip: needsPlugin }, async (t) => {
  const { events } = await applied(t, EventDataLevel.Processed);

  const text = new TextDecoder().decode(successOf(events, "app.web")?.data);

  assert.match(text, /"image":"nginx"/);
  assert.doesNotMatch(text, /s3cret/);
});

test("the event's entity reads as a typed value", { skip: needsPlugin }, async (t) => {
  const { events } = await applied(t, EventDataLevel.Processed);

  const entity = successOf(events, "app.web")?.entity(App);

  assert.ok(entity instanceof App);
  assert.equal(entity.image, "nginx");
  assert.equal(entity.password?.reveal(), undefined);
  assert.equal(`${entity.password}`, "(sensitive)");
});

test("the event's entity is undefined when the event has no data", { skip: needsPlugin }, async (t) => {
  const { events } = await applied(t, EventDataLevel.None);

  assert.equal(successOf(events, "app.web")?.entity(App), undefined);
});

test("an async handler is awaited, in order, before the operation settles", { skip: needsPlugin }, async (t) => {
  const finished: string[] = [];
  let inHandler = 0;
  let overlapped = false;

  const { events } = await applied(t, undefined, async (event) => {
    inHandler += 1;
    overlapped ||= inHandler > 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
    inHandler -= 1;
    finished.push(`${event.operation} ${event.phase} ${event.resourceId}`);
  });

  assert.equal(overlapped, false);
  assert.deepEqual(
    finished,
    events.map((event) => `${event.operation} ${event.phase} ${event.resourceId}`),
  );
});

test("a saved record encodes from an event handler during the operation", { skip: needsPlugin }, async (t) => {
  const texts: string[] = [];

  await applied(t, EventDataLevel.Processed, async (event, config) => {
    if (event.operation === "create" && event.phase === "success" && event.data !== undefined) {
      texts.push(await config.encodeSavedEntity(event.data, { includeComputed: true }));
    }
  });

  assert.ok(texts.some((text) => /image\s*=\s*"nginx"/.test(text)), texts.join("\n"));
});
