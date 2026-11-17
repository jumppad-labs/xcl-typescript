import assert from "node:assert/strict";
import { test } from "node:test";

import { Attribute, Block, Blocks, Int, Label, NamedBlocks } from "../../src/decorators.js";
import { Entity, Meta } from "../../src/entity.js";
import { NotEncodableError, NotRegisteredError } from "../../src/errors.js";
import { ClassMap, GenericEntity, recordBytes, recordOf, typedEntity } from "../../src/hydrate.js";
import { registrationOf } from "../../src/schema.js";
import { Sensitive } from "../../src/sensitive.js";

class Health {
  @Attribute(String) path = "/";
}

class Volume {
  @Label() name!: string;
  @Attribute(String) source!: string;
}

@Entity("app")
class App {
  @Meta() meta!: Meta;
  @Attribute(String) image!: string;
  @Attribute(Int) replicas = 2;
  @Attribute(String, { optional: true }) connectionString?: string;
  @Sensitive(String, { optional: true }) password?: Sensitive<string>;
  @Block(() => Health, { optional: true }) health?: Health;
  @Blocks(() => Volume) volume: Volume[] = [];
  @NamedBlocks(() => Volume) named: Record<string, Volume> = {};
  @Attribute(String, { optional: true }) unused?: string;
}

@Entity("database", "postgres")
class Postgres {
  @Label() kind!: string;
  @Label() title!: string;
  @Attribute(String) location!: string;
}

@Entity("runner")
class Runner {
  @Attribute(Int) workers = 1;
}

@Entity("never")
class Never {
  @Meta() meta!: Meta;
}

const classes = new ClassMap([registrationOf(App), registrationOf(Postgres), registrationOf(Runner)]);

test("a hand-built entity is written from its values, defaults included", () => {
  const app = new App();
  app.image = "nginx";
  app.meta = { name: "web" };

  assert.deepEqual(recordOf(app, classes), {
    meta: { type: "app", name: "web" },
    image: "nginx",
    replicas: 2,
    volume: [],
    named: {},
  });
});

test("a hand-built entity's properties are written under snake_case names", () => {
  const app = new App();
  app.image = "nginx";
  app.meta = { name: "web" };
  app.connectionString = "postgres://x";

  assert.equal(recordOf(app, classes).connection_string, "postgres://x");
});

test("a hand-built entity with no name is refused", () => {
  const app = new App();
  app.image = "nginx";

  assert.throws(() => recordOf(app, classes), NotEncodableError);
});

test("a type with a subtype writes its registration and label fields", () => {
  const entity = new Postgres();
  entity.kind = "postgres";
  entity.title = "main";
  entity.location = "eu";

  assert.deepEqual(recordOf(entity, classes), { meta: { type: "database", subtype: "postgres", name: "main" }, location: "eu" });
});

test("a singleton needs no name", () => {
  assert.deepEqual(recordOf(new Runner(), classes), { meta: { type: "runner" }, workers: 1 });
});

test("a held sensitive value is written as its real value", () => {
  const app = new App();
  app.image = "nginx";
  app.meta = { name: "web" };
  app.password = new Sensitive("s3cret");

  assert.equal(recordOf(app, classes).password, "s3cret");
});

test("a redacted sensitive value is written as the marker", () => {
  const app = new App();
  app.image = "nginx";
  app.meta = { name: "web" };
  app.password = Sensitive.redacted();

  assert.equal(recordOf(app, classes).password, "(sensitive)");
});

test("nested blocks, block lists and named blocks are written with their fields", () => {
  const app = new App();
  app.image = "nginx";
  app.meta = { name: "web" };
  app.health = new Health();
  app.health.path = "/healthz";
  const volume = new Volume();
  volume.name = "data";
  volume.source = "/a";
  app.volume = [volume];
  app.named = { data: volume };

  const record = recordOf(app, classes);

  assert.deepEqual(record.health, { path: "/healthz" });
  assert.deepEqual(record.volume, [{ name: "data", source: "/a" }]);
  assert.deepEqual(record.named, { data: { name: "data", source: "/a" } });
});

test("disabled and dependencies come from the metadata", () => {
  const app = new App();
  app.image = "nginx";
  app.meta = { name: "web", disabled: true, dependsOn: ["app.db"] };

  const record = recordOf(app, classes);

  assert.equal(record.disabled, true);
  assert.deepEqual(record.depends_on, ["app.db"]);
});

test("a looked-up entity that was not changed is written exactly as the engine wrote it", () => {
  const source = {
    meta: { id: "app.web", name: "web", type: "app", extra_key: "kept" },
    image: "nginx",
    replicas: 3,
    password: "(sensitive)",
    volume: [{ name: "data", source: "/a", other: 1 }],
  };

  const record = recordOf(typedEntity(source, App, classes), classes);

  assert.deepEqual(record.image, "nginx");
  assert.deepEqual(record.password, "(sensitive)");
  assert.deepEqual(record.volume, [{ name: "data", source: "/a", other: 1 }]);
  assert.equal((record.meta as Record<string, unknown>).extra_key, "kept");
});

test("a default hydration filled in is left out", () => {
  const source = { meta: { id: "app.web", name: "web", type: "app" }, image: "nginx" };

  const record = recordOf(typedEntity(source, App, classes), classes);

  assert.equal("replicas" in record, false);
  assert.equal("volume" in record, false);
});

test("a changed field is written from the instance", () => {
  const source = { meta: { id: "app.web", name: "web", type: "app" }, image: "nginx", replicas: 3 };
  const entity = typedEntity(source, App, classes);
  entity.replicas = 9;

  const record = recordOf(entity, classes);

  assert.equal(record.replicas, 9);
  assert.equal(record.image, "nginx");
});

test("a field set where the engine wrote none is written", () => {
  const source = { meta: { id: "app.web", name: "web", type: "app" }, image: "nginx" };
  const entity = typedEntity(source, App, classes);
  entity.unused = "now set";

  assert.equal(recordOf(entity, classes).unused, "now set");
});

test("a sensitive value changed from the marker is written as the new value", () => {
  const source = { meta: { id: "app.web", name: "web", type: "app" }, image: "nginx", password: "(sensitive)" };
  const entity = typedEntity(source, App, classes);
  entity.password = new Sensitive("changed");

  assert.equal(recordOf(entity, classes).password, "changed");
});

test("a generic entity is written from the JSON it holds", () => {
  const source = { meta: { id: "docker.network.main", name: "main", type: "docker" }, docker_id: "abc" };

  assert.deepEqual(recordOf(new GenericEntity(source, classes), classes), source);
});

test("a string is not encodable", () => {
  assert.throws(() => recordOf("not an entity", classes), NotEncodableError);
});

test("a number is not encodable", () => {
  assert.throws(() => recordOf(1, classes), NotEncodableError);
});

test("null is not encodable", () => {
  assert.throws(() => recordOf(null, classes), NotEncodableError);
});

test("a plain object is not encodable", () => {
  assert.throws(() => recordOf({ image: "nginx" }, classes), NotEncodableError);
});

test("an array is not encodable", () => {
  assert.throws(() => recordOf([], classes), NotEncodableError);
});

test("an instance of a class never registered throws the not-registered error", () => {
  const entity = new Never();
  entity.meta = { name: "x" };

  assert.throws(() => recordOf(entity, classes), NotRegisteredError);
});

test("a value with no configuration form is not encodable", () => {
  const app = new App();
  app.image = "nginx";
  app.meta = { name: "web" };
  (app as unknown as { image: unknown }).image = () => "not a value";

  assert.throws(() => recordBytes(app, classes), NotEncodableError);
});

test("a bigint has no configuration form", () => {
  const app = new App();
  app.meta = { name: "web" };
  (app as unknown as { image: unknown }).image = 1n;

  assert.throws(() => recordBytes(app, classes), NotEncodableError);
});

test("a circular value has no configuration form", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const app = new App();
  app.meta = { name: "web" };
  (app as unknown as { image: unknown }).image = circular;

  assert.throws(() => recordBytes(app, classes), NotEncodableError);
});

test("record bytes are the record as JSON", () => {
  const app = new App();
  app.image = "nginx";
  app.meta = { name: "web" };

  assert.deepEqual(JSON.parse(new TextDecoder().decode(recordBytes(app, classes))), recordOf(app, classes));
});

// Object values

class Endpoint {
  @Attribute(Int) port!: number;
  @Attribute(Boolean) tls = false;
  @Attribute(String, { optional: true }) path?: string;
  @Sensitive(String, { optional: true }) token?: Sensitive<string>;
}

class Probe {
  @Attribute(String) path!: string;
}

class Check {
  @Attribute(Int) interval = 10;
  @Attribute(() => Probe) probe!: Probe;
}

@Entity("service")
class Service {
  @Meta() meta!: Meta;
  @Attribute(() => Endpoint) defaultEndpoint!: Endpoint;
  @Attribute([() => Endpoint]) endpoints: Endpoint[] = [];
  @Attribute({ map: () => Endpoint }) routes: Record<string, Endpoint> = {};
  @Attribute(() => Check, { optional: true }) check?: Check;
}

const objectClasses = new ClassMap([registrationOf(Service)]);

function endpoint(port: number, tls = false): Endpoint {
  const built = new Endpoint();
  built.port = port;
  built.tls = tls;
  return built;
}

function lookedUpService(): Record<string, unknown> {
  return {
    meta: { id: "service.web", name: "web", type: "service" },
    default_endpoint: { port: 80, tls: true, token: "(sensitive)", extra: "kept" },
    endpoints: [
      { port: 80, tls: false },
      { port: 443, tls: true },
    ],
    routes: { public: { port: 80, tls: false } },
    check: { interval: 5, probe: { path: "/healthz" } },
  };
}

test("a looked-up entity holding objects that was not changed is written exactly as the engine wrote it", () => {
  const source = lookedUpService();

  const record = recordOf(typedEntity(source, Service, objectClasses), objectClasses);

  assert.deepEqual(record.default_endpoint, { port: 80, tls: true, token: "(sensitive)", extra: "kept" });
  assert.deepEqual(record.endpoints, [
    { port: 80, tls: false },
    { port: 443, tls: true },
  ]);
  assert.deepEqual(record.routes, { public: { port: 80, tls: false } });
  assert.deepEqual(record.check, { interval: 5, probe: { path: "/healthz" } });
});

test("a field changed inside an object is written changed, its untouched fields as the engine wrote them", () => {
  const entity = typedEntity(lookedUpService(), Service, objectClasses);
  entity.defaultEndpoint.port = 81;

  const record = recordOf(entity, objectClasses);

  // a changed object is written from its declared fields, as a changed block is
  assert.deepEqual(record.default_endpoint, { port: 81, tls: true, token: "(sensitive)" });
});

test("a field changed inside an object held by an object is written changed", () => {
  const entity = typedEntity(lookedUpService(), Service, objectClasses);
  (entity.check as Check).probe.path = "/ready";

  const record = recordOf(entity, objectClasses);

  assert.deepEqual(record.check, { interval: 5, probe: { path: "/ready" } });
});

test("a list element changed is written changed, the other elements as the engine wrote them", () => {
  const entity = typedEntity(lookedUpService(), Service, objectClasses);
  (entity.endpoints[1] as Endpoint).port = 8443;

  const record = recordOf(entity, objectClasses);

  assert.deepEqual(record.endpoints, [
    { port: 80, tls: false },
    { port: 8443, tls: true },
  ]);
});

test("a map entry added is written beside the entries the engine wrote", () => {
  const entity = typedEntity(lookedUpService(), Service, objectClasses);
  entity.routes.admin = endpoint(9000);

  const record = recordOf(entity, objectClasses);

  assert.deepEqual(record.routes, { public: { port: 80, tls: false }, admin: { port: 9000, tls: false } });
});

test("a sensitive value changed inside an object is written as the new value", () => {
  const entity = typedEntity(lookedUpService(), Service, objectClasses);
  entity.defaultEndpoint.token = new Sensitive("rotated");

  const record = recordOf(entity, objectClasses);

  assert.equal((record.default_endpoint as Record<string, unknown>).token, "rotated");
});

test("a hand-built entity holding objects is written as plain JSON of their fields", () => {
  const service = new Service();
  service.meta = { name: "web" };
  service.defaultEndpoint = endpoint(80, true);
  service.defaultEndpoint.path = "/api";
  service.endpoints = [endpoint(80), endpoint(443, true)];
  service.routes = { public: endpoint(8080) };
  service.check = new Check();
  service.check.probe = new Probe();
  service.check.probe.path = "/healthz";

  assert.deepEqual(recordOf(service, objectClasses), {
    meta: { type: "service", name: "web" },
    default_endpoint: { port: 80, tls: true, path: "/api" },
    endpoints: [
      { port: 80, tls: false },
      { port: 443, tls: true },
    ],
    routes: { public: { port: 8080, tls: false } },
    check: { interval: 10, probe: { path: "/healthz" } },
  });
});

test("a hand-built object's sensitive field is written as its real value", () => {
  const service = new Service();
  service.meta = { name: "web" };
  service.defaultEndpoint = endpoint(80);
  service.defaultEndpoint.token = new Sensitive("s3cret");

  assert.deepEqual(recordOf(service, objectClasses).default_endpoint, { port: 80, tls: false, token: "s3cret" });
});

test("a hand-built entity holding objects serialises to JSON for the engine", () => {
  const service = new Service();
  service.meta = { name: "web" };
  service.defaultEndpoint = endpoint(80);

  assert.deepEqual(JSON.parse(new TextDecoder().decode(recordBytes(service, objectClasses))), {
    meta: { type: "service", name: "web" },
    default_endpoint: { port: 80, tls: false },
    endpoints: [],
    routes: {},
  });
});

// Entity values: references to blocks

@Entity("database", "postgres")
class Database {
  @Meta() meta!: Meta;
  @Attribute(String) location!: string;
  @Attribute(Int) port = 5432;
}

@Entity("database", "postgres")
class SubtypedDatabase {
  @Label() kind!: string;
  @Label() title!: string;
  @Attribute(String) location!: string;
}

@Entity("store")
class Store {
  @Label() name!: string;
  @Attribute(String) location!: string;
}

class UndeclaredStore {
  @Label() kind!: string;
  @Label() title!: string;
  @Attribute(String) location!: string;
}

@Entity("app")
class Consumer {
  @Meta() meta!: Meta;
  @Attribute(() => Database) database!: Database;
  @Attribute([() => Database]) databases: Database[] = [];
  @Attribute({ map: () => Database }) byRole: Record<string, Database> = {};
  @Attribute(() => SubtypedDatabase, { optional: true }) subtyped?: SubtypedDatabase;
  @Attribute(() => Store, { optional: true }) store?: Store;
  @Attribute(() => UndeclaredStore, { optional: true }) undeclared?: UndeclaredStore;
}

const referenceClasses = new ClassMap([registrationOf(Consumer), registrationOf(Database)]);

function lookedUpConsumer(): Record<string, unknown> {
  return {
    meta: {
      id: "app.web",
      name: "web",
      type: "app",
      references: { database: "database.postgres.main", databases: "[database.postgres.main, database.postgres.replica]" },
    },
    database: {
      meta: { id: "database.postgres.main", name: "main", type: "database", subtype: "postgres", file: "/config/main.xcl", line: 1, column: 1 },
      location: "main.internal",
      port: 5432,
    },
    databases: [
      {
        meta: { id: "database.postgres.main", name: "main", type: "database", subtype: "postgres", file: "/config/main.xcl", line: 1, column: 1 },
        location: "main.internal",
        port: 5432,
      },
      {
        meta: { id: "database.postgres.replica", name: "replica", type: "database", subtype: "postgres", file: "/config/main.xcl", line: 5, column: 1 },
        location: "replica.internal",
        port: 6432,
        disabled: true,
      },
    ],
  };
}

function database(name: string, location: string): Database {
  const built = new Database();
  built.meta = { name };
  built.location = location;
  return built;
}

test("a looked-up entity holding references that was not changed is written exactly as the engine wrote it", () => {
  const source = lookedUpConsumer();

  const record = recordOf(typedEntity(source, Consumer, referenceClasses), referenceClasses);

  assert.deepEqual(record, lookedUpConsumer());
});

test("an attribute changed inside a looked-up reference is written changed, with the referenced block's metadata", () => {
  const entity = typedEntity(lookedUpConsumer(), Consumer, referenceClasses);
  entity.database.location = "moved.internal";

  const record = recordOf(entity, referenceClasses);

  assert.deepEqual(record.database, {
    meta: { id: "database.postgres.main", name: "main", type: "database", subtype: "postgres", file: "/config/main.xcl", line: 1, column: 1 },
    location: "moved.internal",
    port: 5432,
  });
});

test("a list element changed inside a looked-up list of references is written with its metadata and disabled, the other element as the engine wrote it", () => {
  const entity = typedEntity(lookedUpConsumer(), Consumer, referenceClasses);
  (entity.databases[1] as Database).port = 7000;

  const record = recordOf(entity, referenceClasses);

  assert.deepEqual(record.databases, [
    {
      meta: { id: "database.postgres.main", name: "main", type: "database", subtype: "postgres", file: "/config/main.xcl", line: 1, column: 1 },
      location: "main.internal",
      port: 5432,
    },
    {
      meta: { id: "database.postgres.replica", name: "replica", type: "database", subtype: "postgres", file: "/config/main.xcl", line: 5, column: 1 },
      disabled: true,
      location: "replica.internal",
      port: 7000,
    },
  ]);
});

test("a hand-built reference is written with the metadata its meta field holds", () => {
  const consumer = new Consumer();
  consumer.meta = { name: "web" };
  consumer.database = new Database();
  consumer.database.meta = { id: "database.postgres.main", name: "main", type: "database", subtype: "postgres" };
  consumer.database.location = "main.internal";

  assert.deepEqual(recordOf(consumer, referenceClasses).database, {
    meta: { id: "database.postgres.main", name: "main", type: "database", subtype: "postgres" },
    location: "main.internal",
    port: 5432,
  });
});

test("a hand-built reference whose meta field holds only a name takes its type and subtype from its class's @Entity", () => {
  const consumer = new Consumer();
  consumer.meta = { name: "web" };
  consumer.database = database("main", "main.internal");

  assert.deepEqual(recordOf(consumer, referenceClasses).database, {
    meta: { type: "database", subtype: "postgres", name: "main" },
    location: "main.internal",
    port: 5432,
  });
});

test("a hand-built reference's disabled and dependencies come from its meta field", () => {
  const consumer = new Consumer();
  consumer.meta = { name: "web" };
  consumer.database = database("main", "main.internal");
  consumer.database.meta = { name: "main", disabled: true, dependsOn: ["app.setup"] };

  assert.deepEqual(recordOf(consumer, referenceClasses).database, {
    meta: { type: "database", subtype: "postgres", name: "main" },
    disabled: true,
    depends_on: ["app.setup"],
    location: "main.internal",
    port: 5432,
  });
});

test("a hand-built reference with two label fields takes its subtype and name from them and its type from @Entity", () => {
  const consumer = new Consumer();
  consumer.meta = { name: "web" };
  consumer.database = database("main", "main.internal");
  consumer.subtyped = new SubtypedDatabase();
  consumer.subtyped.kind = "postgres";
  consumer.subtyped.title = "replica";
  consumer.subtyped.location = "replica.internal";

  assert.deepEqual(recordOf(consumer, referenceClasses).subtyped, {
    meta: { type: "database", subtype: "postgres", name: "replica" },
    location: "replica.internal",
  });
});

test("a hand-built reference with one label field takes its name from it and its type from @Entity", () => {
  const consumer = new Consumer();
  consumer.meta = { name: "web" };
  consumer.database = database("main", "main.internal");
  consumer.store = new Store();
  consumer.store.name = "assets";
  consumer.store.location = "assets.internal";

  assert.deepEqual(recordOf(consumer, referenceClasses).store, {
    meta: { type: "store", name: "assets" },
    location: "assets.internal",
  });
});

test("a hand-built reference of a class with no @Entity takes its subtype and name from its two label fields alone", () => {
  const consumer = new Consumer();
  consumer.meta = { name: "web" };
  consumer.database = database("main", "main.internal");
  consumer.undeclared = new UndeclaredStore();
  consumer.undeclared.kind = "s3";
  consumer.undeclared.title = "assets";
  consumer.undeclared.location = "assets.internal";

  assert.deepEqual(recordOf(consumer, referenceClasses).undeclared, {
    meta: { subtype: "s3", name: "assets" },
    location: "assets.internal",
  });
});

test("a hand-built list and map of references are written with each element's metadata", () => {
  const consumer = new Consumer();
  consumer.meta = { name: "web" };
  consumer.database = database("main", "main.internal");
  consumer.databases = [database("main", "main.internal"), database("replica", "replica.internal")];
  consumer.byRole = { standby: database("replica", "replica.internal") };

  const record = recordOf(consumer, referenceClasses);

  assert.deepEqual(record.databases, [
    { meta: { type: "database", subtype: "postgres", name: "main" }, location: "main.internal", port: 5432 },
    { meta: { type: "database", subtype: "postgres", name: "replica" }, location: "replica.internal", port: 5432 },
  ]);
  assert.deepEqual(record.by_role, {
    standby: { meta: { type: "database", subtype: "postgres", name: "replica" }, location: "replica.internal", port: 5432 },
  });
});

test("a hand-built reference with no name is written with no name rather than refused", () => {
  const consumer = new Consumer();
  consumer.meta = { name: "web" };
  consumer.database = new Database();
  consumer.database.location = "main.internal";

  assert.deepEqual(recordOf(consumer, referenceClasses).database, {
    meta: { type: "database", subtype: "postgres" },
    location: "main.internal",
    port: 5432,
  });
});

test("a hand-built entity holding a reference serialises to JSON for the engine", () => {
  const consumer = new Consumer();
  consumer.meta = { name: "web" };
  consumer.database = database("main", "main.internal");

  assert.deepEqual(JSON.parse(new TextDecoder().decode(recordBytes(consumer, referenceClasses))), {
    meta: { type: "app", name: "web" },
    database: { meta: { type: "database", subtype: "postgres", name: "main" }, location: "main.internal", port: 5432 },
    databases: [],
    by_role: {},
  });
});
