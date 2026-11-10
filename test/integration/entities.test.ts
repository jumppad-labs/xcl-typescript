/**
 * Decorated classes against the real engine: configuration is checked against
 * them as it is for Go types, and lookups return instances of them.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  Attribute,
  Block,
  Blocks,
  Computed,
  ConfigError,
  createConfig,
  Entity,
  Int,
  Label,
  LocalRegistry,
  Meta,
  NamedBlocks,
  NotRegisteredError,
  Sensitive,
  TypeMismatchError,
  type Config,
} from "../../src/index.js";
import { isolateHome, missingEngine, testDirectory, writeConfig } from "../helpers/engine.js";

const needsEngine = missingEngine();
isolateHome();

class Health {
  @Attribute(String) path = "/";
  @Attribute(Int) interval = 10;
}

class Volume {
  @Label() name!: string;
  @Attribute(String) source!: string;
}

class Listener {
  @Label() name!: string;
  @Attribute(Int) port!: number;
}

@Entity("app")
class App {
  @Meta() meta!: Meta;
  @Attribute(String) image!: string;
  @Attribute(Int) replicas = 2;
  @Attribute(String, { optional: true }) connectionString?: string;
  @Sensitive(String, { optional: true }) password?: Sensitive<string>;
  @Computed(String) endpoint?: string;
  @Block(() => Health, { optional: true }) health?: Health;
  @Blocks(() => Volume) volume: Volume[] = [];
  @NamedBlocks(() => Listener) listener: Record<string, Listener> = {};
}

@Entity("database", "postgres")
class Postgres {
  @Meta() meta!: Meta;
  @Attribute(String) location!: string;
}

@Entity("database", "mysql")
class Mysql {
  @Meta() meta!: Meta;
  @Attribute(String) location!: string;
}

@Entity("labelled")
class Labelled {
  @Label() title!: string;
  @Attribute(String) note = "";
}

@Entity("runner")
class Runner {
  @Attribute(Int) workers = 1;
}

@Entity("unused")
class Unused {
  @Meta() meta!: Meta;
}

async function configured(t: TestContext, text: string, ...classes: (new () => object)[]): Promise<{ config: Config; path: string }> {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", text);
  const local = new LocalRegistry();
  local.register(...classes);
  const config = await createConfig({ registries: [local], statePath: join(directory, "state") });
  t.after(() => config.close());
  return { config, path };
}

const WEB = `app "web" {
  image = "nginx"
}
`;

test("a registered type decodes configuration and is found as an instance of its class", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(t, WEB, App);

  await config.validate(path);
  await config.apply(path);
  const web = await config.find(App, "app.web");

  assert.ok(web instanceof App);
  assert.equal(web.image, "nginx");
});

test("a subtype's entity is found at its address", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(
    t,
    `database "postgres" "main" {
  location = "eu"
}
`,
    Postgres,
  );

  await config.apply(path);
  const main = await config.find(Postgres, "database.postgres.main");

  assert.ok(main instanceof Postgres);
  assert.equal(main.location, "eu");
  assert.equal(main.meta.id, "database.postgres.main");
});

// Go's Validate parses without decoding, so a missing required attribute is
// reported by apply, as it is from Go and Python
test("leaving out a required field fails at the block's position", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(
    t,
    `app "web" {
}
`,
    App,
  );

  const error = await config.apply(path).then(
    () => undefined,
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof ConfigError, `the error was: ${String(error)}`);
  assert.equal(error.problems[0]?.line, 1);
  assert.match(error.problems[0]?.file ?? "", /main\.xcl$/);
});

test("a left-out optional field holds its default", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(t, WEB, App);

  await config.apply(path);
  const web = await config.find(App, "app.web");

  assert.equal(web.replicas, 2);
});

test("a sensitive value prints as the marker and reveals nothing from a lookup", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(
    t,
    `app "web" {
  image    = "nginx"
  password = "s3cret"
}
`,
    App,
  );

  await config.apply(path);
  const web = await config.find(App, "app.web");

  assert.equal(`${web.password}`, "(sensitive)");
  assert.equal(web.password?.reveal(), undefined);
});

test("a computed field cannot be set in configuration", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(
    t,
    `app "web" {
  image    = "nginx"
  endpoint = "http://x"
}
`,
    App,
  );

  await assert.rejects(config.validate(path), ConfigError);
});

test("a nested block is decoded into its class", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(
    t,
    `app "web" {
  image = "nginx"

  health {
    path = "/healthz"
  }
}
`,
    App,
  );

  await config.apply(path);
  const web = await config.find(App, "app.web");

  assert.ok(web.health instanceof Health);
  assert.equal(web.health.path, "/healthz");
  assert.equal(web.health.interval, 10);
});

test("two volume blocks give an array of two items in order", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(
    t,
    `app "web" {
  image = "nginx"

  volume "data" {
    source = "/a"
  }

  volume "logs" {
    source = "/b"
  }
}
`,
    App,
  );

  await config.apply(path);
  const web = await config.find(App, "app.web");

  assert.deepEqual(
    web.volume.map((volume) => [volume.name, volume.source]),
    [
      ["data", "/a"],
      ["logs", "/b"],
    ],
  );
  assert.ok(web.volume[0] instanceof Volume);
});

test("two listener blocks give a record keyed by their names", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(
    t,
    `app "web" {
  image = "nginx"

  listener "http" {
    port = 80
  }

  listener "https" {
    port = 443
  }
}
`,
    App,
  );

  await config.apply(path);
  const web = await config.find(App, "app.web");

  assert.equal(web.listener.http?.port, 80);
  assert.equal(web.listener.https?.port, 443);
  assert.equal(web.listener.http?.name, "http");
  assert.ok(web.listener.http instanceof Listener);
});

test("a type with a label field receives the block's label in it", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(
    t,
    `labelled "first" {
  note = "x"
}
`,
    Labelled,
  );

  await config.apply(path);
  const entity = await config.find(Labelled, "labelled.first");

  assert.equal(entity.title, "first");
});

test("a type with a metadata field receives the block's address in it", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(t, WEB, App);

  await config.apply(path);
  const web = await config.find(App, "app.web");

  assert.equal(web.meta.id, "app.web");
  assert.equal(web.meta.name, "web");
  assert.equal(web.meta.type, "app");
});

test("a singleton is written without labels and found by its type alone", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(
    t,
    `runner {
  workers = 4
}
`,
    Runner,
  );

  await config.apply(path);
  const runner = await config.find(Runner, "runner");

  assert.ok(runner instanceof Runner);
  assert.equal(runner.workers, 4);
});

test("a property connectionString reads the configuration's connection_string", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(
    t,
    `app "web" {
  image             = "nginx"
  connection_string = "postgres://x"
}
`,
    App,
  );

  await config.apply(path);
  const web = await config.find(App, "app.web");

  assert.equal(web.connectionString, "postgres://x");
});

const LOOKUPS = `database "postgres" "one" {
  location = "a"
}

database "postgres" "two" {
  location = "b"
}

database "mysql" "three" {
  location = "c"
}

app "web" {
  image = "nginx"
}

variable "region" {
  default = "eu"
}

output "image" {
  value = app.web.image
}
`;

test("finding by type returns the instances of that type", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(t, LOOKUPS, App, Postgres, Mysql);

  await config.apply(path);
  const found = await config.findByType(Postgres, "database", "postgres");

  assert.equal(found.length, 2);
  assert.ok(found.every((entity) => entity instanceof Postgres));
});

test("finding exactly one of a type returns it", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(t, LOOKUPS, App, Postgres, Mysql);

  await config.apply(path);
  const web = await config.findOne(App, "app");

  assert.ok(web instanceof App);
  assert.equal(web.image, "nginx");
});

test("finding all of a registered type returns its instances", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(t, LOOKUPS, App, Postgres, Mysql);

  await config.apply(path);
  const found = await config.all(Postgres);

  assert.deepEqual(found.map((entity) => entity.location).sort(), ["a", "b"]);
  assert.ok(found.every((entity) => entity instanceof Postgres));
});

test("entities returns registered instances, and variables and outputs generically", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(t, LOOKUPS, App, Postgres, Mysql);

  await config.apply(path);
  const everything = await config.entities();

  assert.equal(everything.filter((entity) => entity instanceof App).length, 1);
  assert.equal(everything.filter((entity) => entity instanceof Postgres).length, 2);
  assert.equal(everything.filter((entity) => entity instanceof Mysql).length, 1);
  const generic = everything.filter((entity) => !(entity instanceof App || entity instanceof Postgres || entity instanceof Mysql)) as Entity[];
  assert.deepEqual(generic.map((entity) => entity.meta.id).sort(), ["output.image", "variable.region"]);
});

test("a lookup with no class stays generic even for a registered type", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(t, WEB, App);

  await config.apply(path);
  const web = await config.find("app.web");

  assert.equal(web.attributes.image, "nginx");
  assert.ok(web.as(App) instanceof App);
});

test("asking for a class this configuration did not register throws the not-registered error", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(t, WEB, App);

  await config.apply(path);

  await assert.rejects(config.find(Unused, "app.web"), NotRegisteredError);
});

test("all of a class this configuration did not register throws the not-registered error", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(t, WEB, App);

  await config.apply(path);

  await assert.rejects(config.all(Unused), NotRegisteredError);
});

test("finding an address of another registered type throws the type-mismatch error", { skip: needsEngine }, async (t) => {
  const { config, path } = await configured(t, WEB, App, Postgres);

  await config.apply(path);

  await assert.rejects(config.find(Postgres, "app.web"), TypeMismatchError);
});
