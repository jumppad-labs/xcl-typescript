/**
 * References, attributes whose type is a class with a label or meta field,
 * assigned a whole block by its address, decoded, reported, saved, loaded and
 * written back as configuration by the real engine. Every expected text is
 * Go's, written by hand from what xcl prints for Go types declaring the same
 * fields for the same configuration (a `PostgreSQL` struct with `Meta`,
 * `Location` and an optional `Port`, held by an `App` as `Database PostgreSQL`
 * and `Databases []PostgreSQL`).
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { Attribute, Config, ConfigError, Entity, type Event, EventDataLevel, Int, Label, LocalRegistry, Meta, printDiff } from "../../src/index.js";
import { isolateHome, missingEngine, testDirectory, writeConfig } from "../helpers/engine.js";
import { missingBuild, runScenario, SDK_MODULE } from "../helpers/script.js";

const needsEngine = missingEngine();
const needsBuild = needsEngine || missingBuild();
isolateHome();

/** A referenced block type with a subtype, holding its metadata and both labels. */
@Entity("database", "postgres")
class Postgres {
  @Meta() meta!: Meta;
  @Label() kind!: string;
  @Label() name!: string;
  @Attribute(String) location!: string;
  @Attribute(Int) port = 5432;
}

/** A referenced block type with a label and no meta field. */
@Entity("cache")
class Cache {
  @Label() name!: string;
  @Attribute(String) host!: string;
}

/** A block type of another kind whose attributes fit Postgres. */
@Entity("server")
class Server {
  @Meta() meta!: Meta;
  @Attribute(String) location!: string;
  @Attribute(Int) port = 0;
  @Attribute(String, { optional: true }) region?: string;
}

@Entity("app")
class App {
  @Meta() meta!: Meta;
  @Attribute(String) image!: string;
  @Attribute(() => Postgres) database!: Postgres;
  @Attribute([() => Postgres]) databases: Postgres[] = [];
  @Attribute(() => Cache, { optional: true }) cache?: Cache;
}

function registry(): LocalRegistry {
  const local = new LocalRegistry();
  local.register(Postgres);
  local.register(Cache);
  local.register(Server);
  local.register(App);
  return local;
}

async function open(t: TestContext, text: string): Promise<{ config: Config; path: string; directory: string }> {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", text);
  const config = await new Config({ registries: [registry()], statePath: join(directory, "state") }).setup();
  t.after(() => config.close());
  return { config, path, directory };
}

async function applied(t: TestContext, text: string): Promise<Config> {
  const { config, path } = await open(t, text);
  await config.apply(path);
  return config;
}

async function failure(operation: Promise<unknown>): Promise<ConfigError> {
  const error = await operation.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof ConfigError, `the error was: ${String(error)}`);
  return error;
}

function successOf(events: Event[], resourceId: string): Event | undefined {
  return events.find((event) => event.resourceId === resourceId && event.operation === "create" && event.phase === "success");
}

/** A reference to one block and a list of references to two. */
const REFERENCES = `database "postgres" "a" {
  location = "db-a.internal"
  port     = 5432
}

database "postgres" "b" {
  location = "db-b.internal"
  port     = 6432
}

app "web" {
  image     = "nginx"
  database  = database.postgres.a
  databases = [database.postgres.a, database.postgres.b]
}
`;

/** A reference to a block whose class has a label and no meta field. */
const LABELLED = `database "postgres" "a" {
  location = "db-a.internal"
}

cache "assets" {
  host = "assets.internal"
}

app "web" {
  image    = "nginx"
  database = database.postgres.a
  cache    = cache.assets
}
`;

// --- decoding a reference and a list of references after an apply

test("after an apply, a reference is an instance of its class holding the block's attributes", { skip: needsEngine }, async (t) => {
  const config = await applied(t, REFERENCES);

  const web = await config.find(App, "app.web");

  assert.ok(web.database instanceof Postgres);
  assert.equal(web.database.location, "db-a.internal");
  assert.equal(web.database.port, 5432);
});

test("after an apply, a reference's label fields hold the block's subtype and name", { skip: needsEngine }, async (t) => {
  const config = await applied(t, REFERENCES);

  const web = await config.find(App, "app.web");

  assert.equal(web.database.kind, "postgres");
  assert.equal(web.database.name, "a");
});

test("after an apply, a reference's meta field holds the block's address", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(t, REFERENCES);
  await config.apply(path);

  const web = await config.find(App, "app.web");

  assert.equal(web.database.meta.id, "database.postgres.a");
  assert.equal(web.database.meta.name, "a");
  assert.equal(web.database.meta.type, "database");
  assert.equal(web.database.meta.subtype, "postgres");
  assert.equal(web.database.meta.file, path);
  assert.equal(web.database.meta.line, 1);
  assert.equal(web.database.meta.column, 1);
});

test("after an apply, a list of references holds an instance per block in order, each with its labels, attributes and address", { skip: needsEngine }, async (t) => {
  const config = await applied(t, REFERENCES);

  const web = await config.find(App, "app.web");

  assert.equal(web.databases.length, 2);
  assert.ok(web.databases[0] instanceof Postgres);
  assert.ok(web.databases[1] instanceof Postgres);
  assert.equal(web.databases[0].meta.id, "database.postgres.a");
  assert.equal(web.databases[0].kind, "postgres");
  assert.equal(web.databases[0].name, "a");
  assert.equal(web.databases[0].location, "db-a.internal");
  assert.equal(web.databases[0].port, 5432);
  assert.equal(web.databases[1].meta.id, "database.postgres.b");
  assert.equal(web.databases[1].kind, "postgres");
  assert.equal(web.databases[1].name, "b");
  assert.equal(web.databases[1].location, "db-b.internal");
  assert.equal(web.databases[1].port, 6432);
});

test("after an apply, a reference to a block leaving out a defaulted attribute holds the class's default", { skip: needsEngine }, async (t) => {
  const config = await applied(t, LABELLED);

  const web = await config.find(App, "app.web");

  assert.equal(web.database.location, "db-a.internal");
  assert.equal(web.database.port, 5432);
});

test("after an apply, a reference whose class has a label and no meta field holds the block's name and attributes", { skip: needsEngine }, async (t) => {
  const config = await applied(t, LABELLED);

  const web = await config.find(App, "app.web");

  assert.ok(web.cache instanceof Cache);
  assert.equal(web.cache.name, "assets");
  assert.equal(web.cache.host, "assets.internal");
});

// --- a reference to a block that does not fit the class

// Go's validate checks structure without decoding values, so the unsuitable
// reference is reported by apply, as it is from Go
test("at the apply stage, a reference to a block missing a required attribute is reported at the reference with Go's text", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `cache "assets" {
  host = "assets.internal"
}

app "web" {
  image    = "nginx"
  database = cache.assets
}
`,
  );

  const error = await failure(config.apply(path));

  assert.equal(error.problems.length, 1);
  const problem = error.problems[0];
  assert.equal(problem?.file, path);
  assert.equal(problem?.line, 7);
  assert.equal(problem?.column, 14);
  assert.equal(problem?.summary, "Unsuitable value type");
  assert.equal(problem?.detail, 'Attribute "database": Unsuitable value: attribute "location" is required');
  assert.equal(problem?.entity, "app.web");
  assert.equal(problem?.field, "database");
});

test("at the apply stage, a list element referring to a block missing a required attribute is reported naming the element with Go's text", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `database "postgres" "a" {
  location = "db-a.internal"
}

cache "assets" {
  host = "assets.internal"
}

app "web" {
  image     = "nginx"
  database  = database.postgres.a
  databases = [database.postgres.a, cache.assets]
}
`,
  );

  const error = await failure(config.apply(path));

  assert.equal(error.problems.length, 1);
  const problem = error.problems[0];
  assert.equal(problem?.file, path);
  assert.equal(problem?.line, 12);
  assert.equal(problem?.column, 15);
  assert.equal(problem?.summary, "Unsuitable value type");
  assert.equal(problem?.detail, 'Attribute "databases": Unsuitable value: element 1: attribute "location" is required');
  assert.equal(problem?.entity, "app.web");
  assert.equal(problem?.field, "databases");
});

test("at the validate stage, a reference to a block missing a required attribute is not reported, as Go's validate does not decode values", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `cache "assets" {
  host = "assets.internal"
}

app "web" {
  image    = "nginx"
  database = cache.assets
}
`,
  );

  await config.validate(path);
});

// Go converts the referenced block's value to the field's type, dropping the
// attributes it does not declare, so a block of another type whose attributes
// fit is accepted
test("after an apply, a reference to a block of another type whose attributes fit holds that block's attributes and address", { skip: needsEngine }, async (t) => {
  const config = await applied(
    t,
    `server "east" {
  location = "east.internal"
  port     = 7000
  region   = "us-east"
}

app "web" {
  image    = "nginx"
  database = server.east
}
`,
  );

  const web = await config.find(App, "app.web");

  assert.ok(web.database instanceof Postgres);
  assert.equal(web.database.meta.id, "server.east");
  assert.equal(web.database.meta.type, "server");
  assert.equal(web.database.location, "east.internal");
  assert.equal(web.database.port, 7000);
});

// --- the same references after a load in a new process and from an event

test("an event's entity data gives back each reference with its labels, attributes and address", { skip: needsEngine }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", REFERENCES);
  const events: Event[] = [];
  const config = await new Config({
    registries: [registry()],
    statePath: join(directory, "state"),
    eventData: EventDataLevel.Processed,
    onEvent: (event) => {
      events.push(event);
    },
  }).setup();
  t.after(() => config.close());

  await config.apply(path);
  const web = successOf(events, "app.web")?.entity(App);

  assert.ok(web instanceof App);
  assert.ok(web.database instanceof Postgres);
  assert.equal(web.database.meta.id, "database.postgres.a");
  assert.equal(web.database.kind, "postgres");
  assert.equal(web.database.name, "a");
  assert.equal(web.database.location, "db-a.internal");
  assert.equal(web.database.port, 5432);
  assert.equal(web.databases.length, 2);
  assert.ok(web.databases[0] instanceof Postgres);
  assert.ok(web.databases[1] instanceof Postgres);
  assert.equal(web.databases[0].meta.id, "database.postgres.a");
  assert.equal(web.databases[1].meta.id, "database.postgres.b");
  assert.equal(web.databases[1].name, "b");
  assert.equal(web.databases[1].location, "db-b.internal");
  assert.equal(web.databases[1].port, 6432);
});

// the scenario is plain JavaScript, so it calls the decorators in their legacy form
const SCENARIO_APP = `import { Attribute, Config, Entity, Int, Label, LocalRegistry, Meta } from ${JSON.stringify(SDK_MODULE)};
class Postgres {
  meta;
  kind;
  name;
  location;
  port = 5432;
}
Meta()(Postgres.prototype, "meta");
Label()(Postgres.prototype, "kind");
Label()(Postgres.prototype, "name");
Attribute(String)(Postgres.prototype, "location");
Attribute(Int)(Postgres.prototype, "port");
Entity("database", "postgres")(Postgres);
class Cache {
  name;
  host;
}
Label()(Cache.prototype, "name");
Attribute(String)(Cache.prototype, "host");
Entity("cache")(Cache);
class Server {
  meta;
  location;
  port = 0;
  region;
}
Meta()(Server.prototype, "meta");
Attribute(String)(Server.prototype, "location");
Attribute(Int)(Server.prototype, "port");
Attribute(String, { optional: true })(Server.prototype, "region");
Entity("server")(Server);
class App {
  meta;
  image;
  database;
  databases = [];
  cache;
}
Meta()(App.prototype, "meta");
Attribute(String)(App.prototype, "image");
Attribute(() => Postgres)(App.prototype, "database");
Attribute([() => Postgres])(App.prototype, "databases");
Attribute(() => Cache, { optional: true })(App.prototype, "cache");
Entity("app")(App);
const local = new LocalRegistry();
local.register(Postgres);
local.register(Cache);
local.register(Server);
local.register(App);`;

test("a load in a new process gives back each reference saved by an apply", { skip: needsBuild }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", REFERENCES);
  const state = join(directory, "state");
  {
    await using config = await new Config({ registries: [registry()], statePath: state }).setup();
    await config.apply(path);
  }

  const script = await runScenario(
    `${SCENARIO_APP}
const config = await new Config({ registries: [local], statePath: ${JSON.stringify(state)} }).setup();
await config.load();
const web = await config.find(App, "app.web");
const describe = (database) => [database instanceof Postgres, database.meta.id, database.kind, database.name, database.location, database.port].join(",");
console.log("database:" + describe(web.database));
console.log("databases:" + web.databases.map(describe).join(";"));
await config.close();
`,
    directory,
  );

  assert.equal(script.exitCode, 0, script.stderr);
  assert.equal(script.values("database:")[0], "true,database.postgres.a,postgres,a,db-a.internal,5432");
  assert.equal(script.values("databases:")[0], "true,database.postgres.a,postgres,a,db-a.internal,5432;true,database.postgres.b,postgres,b,db-b.internal,6432");
});

test("a load in a new process gives back a reference whose class has a label and no meta field", { skip: needsBuild }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", LABELLED);
  const state = join(directory, "state");
  {
    await using config = await new Config({ registries: [registry()], statePath: state }).setup();
    await config.apply(path);
  }

  const script = await runScenario(
    `${SCENARIO_APP}
const config = await new Config({ registries: [local], statePath: ${JSON.stringify(state)} }).setup();
await config.load();
const web = await config.find(App, "app.web");
console.log("cache:" + [web.cache instanceof Cache, web.cache.name, web.cache.host].join(","));
await config.close();
`,
    directory,
  );

  assert.equal(script.exitCode, 0, script.stderr);
  assert.equal(script.values("cache:")[0], "true,assets,assets.internal");
});

// --- encoding, printing and diffs

/** Go's text for app.web applied from REFERENCES, with references resolved and shown. */
const REFERENCES_EXPECTED = {
  resolved: `app "web" {
  image = "nginx"
  database = {
    location = "db-a.internal"
    port     = 5432
  }
  databases = [{
    location = "db-a.internal"
    port     = 5432
    }, {
    location = "db-b.internal"
    port     = 6432
  }]
}
`,
  shown: `app "web" {
  image     = "nginx"
  database  = database.postgres.a
  databases = [database.postgres.a, database.postgres.b]
}
`,
};

test("encoding an entity holding references gives Go's text, each reference written as the block's attributes", { skip: needsEngine }, async (t) => {
  const config = await applied(t, REFERENCES);
  const web = await config.find(App, "app.web");

  assert.equal(await config.encodeEntity(web), REFERENCES_EXPECTED.resolved);
});

test("encoding an entity holding references with showReferences gives Go's text, each reference written as its address", { skip: needsEngine }, async (t) => {
  const config = await applied(t, REFERENCES);
  const web = await config.find(App, "app.web");

  assert.equal(await config.encodeEntity(web, { showReferences: true }), REFERENCES_EXPECTED.shown);
});

test("printing an entity holding references gives Go's text", { skip: needsEngine }, async (t) => {
  const config = await applied(t, REFERENCES);
  const web = await config.find(App, "app.web");
  let text = "";

  await config.printEntity(web, { out: { write: (chunk) => (text += chunk) } });

  assert.equal(text, REFERENCES_EXPECTED.resolved);
});

test("printing an entity holding references with showReferences gives Go's text", { skip: needsEngine }, async (t) => {
  const config = await applied(t, REFERENCES);
  const web = await config.find(App, "app.web");
  let text = "";

  await config.printEntity(web, { showReferences: true, out: { write: (chunk) => (text += chunk) } });

  assert.equal(text, REFERENCES_EXPECTED.shown);
});

test("an attribute changed inside a looked-up reference is encoded with its new value", { skip: needsEngine }, async (t) => {
  const config = await applied(t, REFERENCES);
  const web = await config.find(App, "app.web");

  web.database.location = "moved.internal";

  assert.equal(
    await config.encodeEntity(web),
    `app "web" {
  image = "nginx"
  database = {
    location = "moved.internal"
    port     = 5432
  }
  databases = [{
    location = "db-a.internal"
    port     = 5432
    }, {
    location = "db-b.internal"
    port     = 6432
  }]
}
`,
  );
});

test("a hand-built entity holding a reference encodes it as the referenced block's attributes", { skip: needsEngine }, async (t) => {
  const { config } = await open(t, REFERENCES);
  const database = new Postgres();
  database.kind = "postgres";
  database.name = "a";
  database.location = "db-a.internal";
  const draft = new App();
  draft.meta = { name: "web" };
  draft.image = "nginx";
  draft.database = database;

  // the class's empty list is a value the draft holds, so Go writes it
  assert.equal(
    await config.encodeEntity(draft),
    `app "web" {
  image = "nginx"
  database = {
    location = "db-a.internal"
    port     = 5432
  }
  databases = []
}
`,
  );
});

// Go leaves a registered type, which has no provider, out of a diff (xcl
// internal/parser/lifecycle.go: decideResource returns early when
// handledWithoutProvider), so changing a referenced block lists no change for
// the block or the entity referring to it. The same configuration and change
// with Go types that have no provider gives Go's text below.
test("a diff after changing an attribute of a referenced block gives Go's text for types with no provider", { skip: needsEngine }, async (t) => {
  const { config, path, directory } = await open(t, REFERENCES);
  await config.apply(path);
  const changed = writeConfig(directory, "main.xcl", REFERENCES.replace('location = "db-a.internal"', 'location = "db-c.internal"'));

  const diff = await config.diff(changed);
  let text = "";
  printDiff(diff, { out: { write: (chunk) => (text += chunk) } });

  assert.equal(diff.resource("app.web"), undefined);
  assert.equal(diff.resource("database.postgres.a"), undefined);
  assert.equal(text, "Diff: no changes, 0 unchanged.\n");
});
