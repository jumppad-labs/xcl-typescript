/**
 * The examples of xcl.dev's "Attributes and blocks" page, written in
 * TypeScript: the "Object values" example, and the `app` type the page
 * assembles field by field; and the whole-entity example of its "References"
 * page. Each is registered, applied and read back through the real engine.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { Attribute, Block, Blocks, Computed, Config, Entity, Int, Label, LocalRegistry, Meta, NamedBlocks, Sensitive } from "../../src/index.js";
import { isSensitive } from "../../src/sensitive.js";
import { isolateHome, missingEngine, testDirectory, writeConfig } from "../helpers/engine.js";

const needsEngine = missingEngine();
isolateHome();

// the assembled example reads its token with env("WEB_TOKEN"); the engine
// starts with this file's first configuration and takes its environment then
process.env.WEB_TOKEN = "s3cret";

async function applied(t: TestContext, text: string, local: LocalRegistry): Promise<Config> {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", text);
  const config = await new Config({ registries: [local], statePath: join(directory, "state") }).setup();
  t.after(() => config.close());
  await config.apply(path);
  return config;
}

// --- "Object values"

class ObjectValuesEndpoint {
  @Attribute(Int) port!: number;
  @Attribute(Boolean) tls = false;
}

@Entity("app")
class ObjectValuesApp {
  @Meta() meta!: Meta;
  @Label() name!: string;
  @Attribute(String) image!: string;
  @Attribute(() => ObjectValuesEndpoint, { optional: true }) defaultEndpoint?: ObjectValuesEndpoint;
}

const OBJECT_VALUES = `app "web" {
  image = "nginx:1.27"
  default_endpoint = { port = 80, tls = true }
}
`;

test("the website's object values example registers, applies and reads back", { skip: needsEngine }, async (t) => {
  const local = new LocalRegistry();
  local.register(ObjectValuesApp);
  const config = await applied(t, OBJECT_VALUES, local);

  const web = await config.find(ObjectValuesApp, "app.web");

  assert.ok(web instanceof ObjectValuesApp);
  assert.equal(web.name, "web");
  assert.equal(web.image, "nginx:1.27");
  assert.ok(web.defaultEndpoint instanceof ObjectValuesEndpoint);
  assert.equal(web.defaultEndpoint.port, 80);
  assert.equal(web.defaultEndpoint.tls, true);
});

// --- the assembled `app` type

class Health {
  @Attribute(String) path!: string;
  @Attribute(Int, { optional: true }) interval?: number;
}

class Volume {
  @Label() name!: string;
  @Attribute(String) source!: string;
}

class Listener {
  @Label() name!: string;
  @Attribute(Int) port!: number;
  @Attribute(Boolean) tls = false;
}

class Endpoint {
  @Attribute(Int) port!: number;
  @Attribute(Boolean) tls = false;
}

@Entity("app")
class App {
  @Meta() meta!: Meta;
  @Label() name!: string;
  @Attribute(String) image!: string;
  @Attribute(Int) replicas = 2;
  @Block(() => Health, { optional: true }) health?: Health;
  @Blocks(() => Volume) volume: Volume[] = [];
  @NamedBlocks(() => Listener) listener: Record<string, Listener> = {};
  @Attribute({ map: String }, { optional: true }) labels: Record<string, string> = {};
  @Attribute(() => Endpoint, { optional: true }) defaultEndpoint?: Endpoint;
  @Computed(String) endpoint?: string;
  @Sensitive(String, { optional: true }) token?: Sensitive<string>;
}

/** The page's configuration fragments, put together in one block, and its output reading the computed field. */
const ASSEMBLED = `app "web" {
  image    = "nginx:1.27"
  replicas = 3

  health {
    path     = "/healthz"
    interval = 10
  }

  volume "data" {
    source = "/var/lib/web"
  }

  volume {
    source = "/tmp/cache"
  }

  listener "http" {
    port = 80
  }

  listener "https" {
    port = 443
    tls  = true
  }

  labels = {
    team = "platform"
    tier = "frontend"
  }

  default_endpoint = { port = 80, tls = true }

  token = env("WEB_TOKEN")
}

output "url" {
  value = app.web.endpoint
}
`;

function assembledRegistry(): LocalRegistry {
  const local = new LocalRegistry();
  local.register(App);
  return local;
}

test("the website's assembled app reads back its attributes", { skip: needsEngine }, async (t) => {
  const config = await applied(t, ASSEMBLED, assembledRegistry());

  const web = await config.find(App, "app.web");

  assert.ok(web instanceof App);
  assert.equal(web.name, "web");
  assert.equal(web.image, "nginx:1.27");
  assert.equal(web.replicas, 3);
  assert.deepEqual(web.labels, { team: "platform", tier: "frontend" });
});

test("the website's assembled app reads back its nested block", { skip: needsEngine }, async (t) => {
  const config = await applied(t, ASSEMBLED, assembledRegistry());

  const web = await config.find(App, "app.web");

  assert.ok(web.health instanceof Health);
  assert.equal(web.health.path, "/healthz");
  assert.equal(web.health.interval, 10);
});

test("the website's assembled app reads back its list of blocks in order", { skip: needsEngine }, async (t) => {
  const config = await applied(t, ASSEMBLED, assembledRegistry());

  const web = await config.find(App, "app.web");

  assert.equal(web.volume.length, 2);
  assert.ok(web.volume[0] instanceof Volume);
  assert.equal(web.volume[0].name, "data");
  assert.equal(web.volume[0].source, "/var/lib/web");
  assert.ok(web.volume[1] instanceof Volume);
  assert.equal(web.volume[1].source, "/tmp/cache");
});

test("the website's assembled app reads back its named blocks by name", { skip: needsEngine }, async (t) => {
  const config = await applied(t, ASSEMBLED, assembledRegistry());

  const web = await config.find(App, "app.web");

  assert.deepEqual(Object.keys(web.listener).sort(), ["http", "https"]);
  assert.ok(web.listener.http instanceof Listener);
  assert.equal(web.listener.http.port, 80);
  assert.equal(web.listener.http.tls, false);
  assert.ok(web.listener.https instanceof Listener);
  assert.equal(web.listener.https.port, 443);
  assert.equal(web.listener.https.tls, true);
});

test("the website's assembled app reads back its object value", { skip: needsEngine }, async (t) => {
  const config = await applied(t, ASSEMBLED, assembledRegistry());

  const web = await config.find(App, "app.web");

  assert.ok(web.defaultEndpoint instanceof Endpoint);
  assert.equal(web.defaultEndpoint.port, 80);
  assert.equal(web.defaultEndpoint.tls, true);
});

test("the website's assembled app reads back its sensitive token redacted", { skip: needsEngine }, async (t) => {
  const config = await applied(t, ASSEMBLED, assembledRegistry());

  const web = await config.find(App, "app.web");

  assert.ok(isSensitive(web.token));
  assert.equal(web.token.isRedacted, true);
  assert.equal(`${web.token}`, "(sensitive)");
});

// a TypeScript entity type has no provider, so nothing fills the computed field in
test("the website's assembled app leaves its computed endpoint unset", { skip: needsEngine }, async (t) => {
  const config = await applied(t, ASSEMBLED, assembledRegistry());

  const web = await config.find(App, "app.web");

  assert.equal(web.endpoint, undefined);
});

/** Go's text for the assembled app revealing its token, as xcl encodes the Go type the page declares. */
const ASSEMBLED_ENCODED = `app "web" {
  image    = "nginx:1.27"
  replicas = 3

  health {
    path     = "/healthz"
    interval = 10
  }

  volume "data" {
    source = "/var/lib/web"
  }

  volume "" {
    source = "/tmp/cache"
  }

  listener "http" {
    port = 80
  }

  listener "https" {
    port = 443
    tls  = true
  }

  labels = {
    team = "platform"
    tier = "frontend"
  }
  default_endpoint = {
    port = 80
    tls  = true
  }
  token = "s3cret"
}
`;

test("the website's assembled app encodes as Go's text, with its token from the environment", { skip: needsEngine }, async (t) => {
  const config = await applied(t, ASSEMBLED, assembledRegistry());
  const web = await config.find(App, "app.web");

  assert.equal(await config.encodeEntity(web, { revealSensitive: true }), ASSEMBLED_ENCODED);
});

// --- "References": a whole entity as a value

@Entity("database", "postgres")
class ReferencesPostgreSQL {
  @Meta() meta!: Meta;
  @Attribute(String) location!: string;
  @Attribute(Int, { optional: true }) port?: number;
}

@Entity("app")
class ReferencesApp {
  @Label() name!: string;
  @Attribute(String) image!: string;
  @Attribute(() => ReferencesPostgreSQL) database!: ReferencesPostgreSQL;
  @Attribute([() => ReferencesPostgreSQL], { optional: true }) databases: ReferencesPostgreSQL[] = [];
}

const REFERENCES = `database "postgres" "main" {
  location = "db.internal"
  port     = 5432
}

database "postgres" "replica" {
  location = "db-replica.internal"
}

app "web" {
  image     = "nginx:1.27"
  database  = database.postgres.main
  databases = [database.postgres.main, database.postgres.replica]
}
`;

function referencesRegistry(): LocalRegistry {
  const local = new LocalRegistry();
  local.register(ReferencesPostgreSQL);
  local.register(ReferencesApp);
  return local;
}

test("the website's references example registers, applies and reads back the referring app", { skip: needsEngine }, async (t) => {
  const config = await applied(t, REFERENCES, referencesRegistry());

  const web = await config.find(ReferencesApp, "app.web");

  assert.ok(web instanceof ReferencesApp);
  assert.equal(web.name, "web");
  assert.equal(web.image, "nginx:1.27");
});

test("the website's references example reads back the referenced database with its address", { skip: needsEngine }, async (t) => {
  const config = await applied(t, REFERENCES, referencesRegistry());

  const web = await config.find(ReferencesApp, "app.web");

  assert.ok(web.database instanceof ReferencesPostgreSQL);
  assert.equal(web.database.meta.id, "database.postgres.main");
  assert.equal(web.database.meta.name, "main");
  assert.equal(web.database.location, "db.internal");
  assert.equal(web.database.port, 5432);
});

test("the website's references example reads back the list of referenced databases in order, each with its address", { skip: needsEngine }, async (t) => {
  const config = await applied(t, REFERENCES, referencesRegistry());

  const web = await config.find(ReferencesApp, "app.web");

  assert.equal(web.databases.length, 2);
  assert.ok(web.databases[0] instanceof ReferencesPostgreSQL);
  assert.equal(web.databases[0].meta.id, "database.postgres.main");
  assert.equal(web.databases[0].meta.name, "main");
  assert.equal(web.databases[0].location, "db.internal");
  assert.equal(web.databases[0].port, 5432);
  assert.ok(web.databases[1] instanceof ReferencesPostgreSQL);
  assert.equal(web.databases[1].meta.id, "database.postgres.replica");
  assert.equal(web.databases[1].meta.name, "replica");
  assert.equal(web.databases[1].location, "db-replica.internal");
  assert.equal(web.databases[1].port, undefined);
});
