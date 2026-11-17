import assert from "node:assert/strict";
import { test } from "node:test";

import { Attribute, Block, Blocks, Computed, Int, Label, NamedBlocks } from "../../src/decorators.js";
import { Entity, Meta } from "../../src/entity.js";
import { NotRegisteredError, SchemaError, TypeMismatchError } from "../../src/errors.js";
import { ClassMap, GenericEntity, hydrate, sourceOf, typedEntity } from "../../src/hydrate.js";
import { registrationOf } from "../../src/schema.js";
import { isSensitive, Sensitive } from "../../src/sensitive.js";

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
  @Attribute(String) connectionString = "";
  @Attribute(String, { optional: true }) region?: string;
  @Sensitive(String, { optional: true }) password?: Sensitive<string>;
  @Computed(String) endpoint?: string;
  @Block(() => Health, { optional: true }) health?: Health;
  @Blocks(() => Volume) volume: Volume[] = [];
  @NamedBlocks(() => Listener) listener: Record<string, Listener> = {};
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

@Entity("other")
class Other {
  @Meta() meta!: Meta;
}

@Entity("unused")
class Unused {
  @Meta() meta!: Meta;
}

const classes = new ClassMap([registrationOf(App), registrationOf(Postgres), registrationOf(Runner), registrationOf(Other)]);

function appRecord(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { meta: { id: "app.web", name: "web", type: "app" }, image: "nginx", ...fields };
}

test("a record of a registered type becomes an instance of its class", () => {
  const entity = hydrate(appRecord(), classes);

  assert.ok(entity instanceof App);
  assert.equal(entity.image, "nginx");
});

test("a record of an unregistered type becomes a generic entity", () => {
  const entity = hydrate({ meta: { id: "docker.network.main", name: "main", type: "docker", subtype: "network" }, docker_id: "abc" }, classes);

  assert.ok(entity instanceof GenericEntity);
  assert.equal(entity.attributes.dockerId, "abc");
});

test("a left-out optional field holds its default", () => {
  const entity = typedEntity(appRecord(), App, classes);

  assert.equal(entity.replicas, 2);
});

test("a configured value replaces the default", () => {
  const entity = typedEntity(appRecord({ replicas: 5 }), App, classes);

  assert.equal(entity.replicas, 5);
});

test("a left-out optional field with no default is undefined", () => {
  const entity = typedEntity(appRecord(), App, classes);

  assert.equal(entity.region, undefined);
});

test("a null value is undefined", () => {
  const entity = typedEntity(appRecord({ region: null }), App, classes);

  assert.equal(entity.region, undefined);
});

test("a camelCase property reads its snake_case key", () => {
  const entity = typedEntity(appRecord({ connection_string: "postgres://x" }), App, classes);

  assert.equal(entity.connectionString, "postgres://x");
});

test("a nested block is decoded into its class", () => {
  const entity = typedEntity(appRecord({ health: { path: "/healthz", interval: 5 } }), App, classes);

  assert.ok(entity.health instanceof Health);
  assert.equal(entity.health.path, "/healthz");
  assert.equal(entity.health.interval, 5);
});

test("block lists keep their order and are decoded into their class", () => {
  const entity = typedEntity(
    appRecord({
      volume: [
        { name: "data", source: "/a" },
        { name: "logs", source: "/b" },
      ],
    }),
    App,
    classes,
  );

  assert.equal(entity.volume.length, 2);
  assert.ok(entity.volume[0] instanceof Volume);
  assert.equal(entity.volume[0].name, "data");
  assert.equal(entity.volume[1]?.source, "/b");
});

test("named blocks are a record keyed by name", () => {
  const entity = typedEntity(appRecord({ listener: { http: { name: "http", port: 80 }, https: { name: "https", port: 443 } } }), App, classes);

  assert.deepEqual(Object.keys(entity.listener), ["http", "https"]);
  assert.ok(entity.listener.http instanceof Listener);
  assert.equal(entity.listener.https?.port, 443);
});

test("the metadata field receives the block's metadata", () => {
  const entity = typedEntity(appRecord({ disabled: true, depends_on: ["app.db"] }), App, classes);

  assert.equal(entity.meta.id, "app.web");
  assert.equal(entity.meta.name, "web");
  assert.equal(entity.meta.disabled, true);
  assert.deepEqual(entity.meta.dependsOn, ["app.db"]);
});

test("one label field receives the block's name", () => {
  class Named {
    @Label() title!: string;
  }
  const NamedEntity = Entity("named")(Named) ?? Named;
  const local = new ClassMap([registrationOf(NamedEntity)]);

  const entity = typedEntity({ meta: { id: "named.one", name: "one", type: "named" } }, NamedEntity, local);

  assert.equal(entity.title, "one");
});

test("two label fields receive the subtype and the name", () => {
  const entity = typedEntity({ meta: { id: "database.postgres.main", name: "main", type: "database", subtype: "postgres" }, location: "eu" }, Postgres, classes);

  assert.equal(entity.kind, "postgres");
  assert.equal(entity.title, "main");
  assert.equal(entity.location, "eu");
});

test("a singleton hydrates without labels", () => {
  const entity = typedEntity({ meta: { id: "runner", name: "runner", type: "runner" }, workers: 3 }, Runner, classes);

  assert.equal(entity.workers, 3);
});

test("the sensitive marker becomes a redacted value", () => {
  const entity = typedEntity(appRecord({ password: "(sensitive)" }), App, classes);

  assert.equal(entity.password?.isRedacted, true);
  assert.equal(entity.password?.reveal(), undefined);
  assert.equal(String(entity.password), "(sensitive)");
});

test("a masked envelope becomes a redacted value", () => {
  const entity = typedEntity(appRecord({ password: { xcl_masked: "aes256gcm", value: "abc" } }), App, classes);

  assert.equal(entity.password?.isRedacted, true);
});

test("a real sensitive value is held", () => {
  const entity = typedEntity(appRecord({ password: "s3cret" }), App, classes);

  assert.equal(entity.password?.reveal(), "s3cret");
  assert.equal(`${entity.password}`, "(sensitive)");
});

test("a hydrated instance remembers the JSON it came from", () => {
  const record = appRecord();

  const entity = typedEntity(record, App, classes);

  assert.equal(sourceOf(entity), record);
});

test("a hand-built instance has no source", () => {
  assert.equal(sourceOf(new App()), undefined);
});

test("asking for a class this configuration did not register throws the not-registered error", () => {
  assert.throws(() => typedEntity(appRecord(), Unused, classes), NotRegisteredError);
});

test("the not-registered error names the class", () => {
  assert.throws(
    () => classes.namesOf(Unused),
    (error: unknown) => error instanceof NotRegisteredError && error.message.includes("Unused"),
  );
});

test("an entity of another type throws the type-mismatch error", () => {
  assert.throws(
    () => typedEntity(appRecord(), Other, classes),
    (error: unknown) => {
      assert.ok(error instanceof TypeMismatchError);
      assert.equal(error.details.want, "other");
      assert.equal(error.details.got, "app");
      return true;
    },
  );
});

test("a generic entity converts to its registered class", () => {
  const generic = new GenericEntity(appRecord(), classes);

  const entity = generic.as(App);

  assert.ok(entity instanceof App);
  assert.equal(entity.image, "nginx");
});

test("a generic entity refuses a class that is not registered", () => {
  const generic = new GenericEntity(appRecord(), classes);

  assert.throws(() => generic.as(Unused), NotRegisteredError);
});

test("a class registered as two block types is refused", () => {
  const twice = registrationOf(App);

  assert.throws(() => new ClassMap([twice, { ...twice, type: "other" }]), SchemaError);
});

test("the same registration twice is accepted", () => {
  const twice = registrationOf(App);

  assert.doesNotThrow(() => new ClassMap([twice, twice]));
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
  @Computed(() => Endpoint) assigned?: Endpoint;
}

const objectClasses = new ClassMap([registrationOf(Service)]);

function serviceRecord(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { meta: { id: "service.web", name: "web", type: "service" }, default_endpoint: { port: 80, tls: true }, ...fields };
}

test("an object value becomes an instance of its class holding its values", () => {
  const entity = typedEntity(serviceRecord(), Service, objectClasses);

  assert.ok(entity.defaultEndpoint instanceof Endpoint);
  assert.equal(entity.defaultEndpoint.port, 80);
  assert.equal(entity.defaultEndpoint.tls, true);
});

test("an object's left-out defaulted field keeps its default", () => {
  const entity = typedEntity(serviceRecord({ default_endpoint: { port: 80 } }), Service, objectClasses);

  assert.equal(entity.defaultEndpoint.tls, false);
});

test("an object's left-out optional field with no default is unset", () => {
  const entity = typedEntity(serviceRecord(), Service, objectClasses);

  assert.equal(entity.defaultEndpoint.path, undefined);
});

test("an object's null optional field is unset", () => {
  const entity = typedEntity(serviceRecord({ default_endpoint: { port: 80, path: null } }), Service, objectClasses);

  assert.equal(entity.defaultEndpoint.path, undefined);
});

test("an object's snake_case keys fill its camelCase properties", () => {
  class Listener {
    @Attribute(Int) listenPort!: number;
  }

  @Entity("proxy")
  class Proxy {
    @Meta() meta!: Meta;
    @Attribute(() => Listener) listener!: Listener;
  }

  const entity = typedEntity({ meta: { id: "proxy.edge", name: "edge", type: "proxy" }, listener: { listen_port: 8080 } }, Proxy, new ClassMap([registrationOf(Proxy)]));

  assert.equal(entity.listener.listenPort, 8080);
});

test("a list of objects becomes instances of their class, in order", () => {
  const entity = typedEntity(serviceRecord({ endpoints: [{ port: 80 }, { port: 443, tls: true }] }), Service, objectClasses);

  assert.equal(entity.endpoints.length, 2);
  assert.ok(entity.endpoints[0] instanceof Endpoint);
  assert.ok(entity.endpoints[1] instanceof Endpoint);
  assert.equal(entity.endpoints[0].port, 80);
  assert.equal(entity.endpoints[1].port, 443);
  assert.equal(entity.endpoints[1].tls, true);
});

test("a map of objects becomes a record of instances keyed as written", () => {
  const entity = typedEntity(serviceRecord({ routes: { public: { port: 80 }, admin: { port: 9000 } } }), Service, objectClasses);

  assert.deepEqual(Object.keys(entity.routes), ["public", "admin"]);
  assert.ok(entity.routes.public instanceof Endpoint);
  assert.ok(entity.routes.admin instanceof Endpoint);
  assert.equal(entity.routes.admin.port, 9000);
});

test("an object held by an object becomes an instance of its own class", () => {
  const entity = typedEntity(serviceRecord({ check: { interval: 5, probe: { path: "/healthz" } } }), Service, objectClasses);

  assert.ok(entity.check instanceof Check);
  assert.equal(entity.check.interval, 5);
  assert.ok(entity.check.probe instanceof Probe);
  assert.equal(entity.check.probe.path, "/healthz");
});

test("a left-out optional object is unset", () => {
  const entity = typedEntity(serviceRecord(), Service, objectClasses);

  assert.equal(entity.check, undefined);
});

test("a left-out list of objects keeps its empty default", () => {
  const entity = typedEntity(serviceRecord(), Service, objectClasses);

  assert.deepEqual(entity.endpoints, []);
  assert.deepEqual(entity.routes, {});
});

test("a computed object becomes an instance of its class", () => {
  const entity = typedEntity(serviceRecord({ assigned: { port: 31000 } }), Service, objectClasses);

  assert.ok(entity.assigned instanceof Endpoint);
  assert.equal(entity.assigned.port, 31000);
});

test("an object's sensitive field holding the marker becomes a redacted value", () => {
  const entity = typedEntity(serviceRecord({ default_endpoint: { port: 80, token: "(sensitive)" } }), Service, objectClasses);

  assert.equal(entity.defaultEndpoint.token?.isRedacted, true);
  assert.equal(entity.defaultEndpoint.token?.reveal(), undefined);
});

test("an object's sensitive field holding a real value becomes a Sensitive holding it", () => {
  const entity = typedEntity(serviceRecord({ default_endpoint: { port: 80, token: "s3cret" } }), Service, objectClasses);

  assert.ok(isSensitive(entity.defaultEndpoint.token));
  assert.equal(entity.defaultEndpoint.token.isRedacted, false);
  assert.equal(entity.defaultEndpoint.token.reveal(), "s3cret");
});

test("a sensitive field of an object in a list holding the marker becomes a redacted value", () => {
  const entity = typedEntity(serviceRecord({ endpoints: [{ port: 80, token: "(sensitive)" }] }), Service, objectClasses);

  assert.equal(entity.endpoints[0]?.token?.isRedacted, true);
});

test("a value for an object attribute that is not a JSON object is left as it is", () => {
  const entity = typedEntity(serviceRecord({ default_endpoint: "not an object" }), Service, objectClasses);

  assert.equal(entity.defaultEndpoint as unknown, "not an object");
});

test("a value for a list of objects that is not an array is left as it is", () => {
  const entity = typedEntity(serviceRecord({ endpoints: "not a list" }), Service, objectClasses);

  assert.equal(entity.endpoints as unknown, "not a list");
});

// Entity values: references to blocks

@Entity("database", "postgres")
class Database {
  @Meta() meta!: Meta;
  @Attribute(String) location!: string;
  @Attribute(Int) port = 5432;
}

class LabelledDatabase {
  @Label() name!: string;
  @Attribute(String) location!: string;
}

class SubtypedDatabase {
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
  @Attribute(() => LabelledDatabase, { optional: true }) labelled?: LabelledDatabase;
  @Attribute(() => SubtypedDatabase, { optional: true }) subtyped?: SubtypedDatabase;
}

const referenceClasses = new ClassMap([registrationOf(Consumer), registrationOf(Database)]);

/** The engine's JSON for a reference to the database "postgres" block named `name`. */
function databaseValue(name: string, line: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: { id: `database.postgres.${name}`, name, type: "database", subtype: "postgres", file: "/config/main.xcl", line, column: 1 },
    location: `${name}.internal`,
    port: 5432,
    ...fields,
  };
}

function consumerRecord(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { meta: { id: "app.web", name: "web", type: "app" }, database: databaseValue("main", 1), ...fields };
}

test("a reference becomes an instance of its class holding the referenced block's attributes", () => {
  const entity = typedEntity(consumerRecord(), Consumer, referenceClasses);

  assert.ok(entity.database instanceof Database);
  assert.equal(entity.database.location, "main.internal");
  assert.equal(entity.database.port, 5432);
});

test("a reference's meta field receives the referenced block's metadata", () => {
  const entity = typedEntity(consumerRecord(), Consumer, referenceClasses);

  assert.equal(entity.database.meta.id, "database.postgres.main");
  assert.equal(entity.database.meta.name, "main");
  assert.equal(entity.database.meta.type, "database");
  assert.equal(entity.database.meta.subtype, "postgres");
  assert.equal(entity.database.meta.file, "/config/main.xcl");
  assert.equal(entity.database.meta.line, 1);
  assert.equal(entity.database.meta.column, 1);
});

test("a reference's meta field receives the referenced block's disabled and dependencies", () => {
  const entity = typedEntity(consumerRecord({ database: databaseValue("main", 1, { disabled: true, depends_on: ["app.setup"] }) }), Consumer, referenceClasses);

  assert.equal(entity.database.meta.disabled, true);
  assert.deepEqual(entity.database.meta.dependsOn, ["app.setup"]);
});

test("a reference's one label field receives the referenced block's name", () => {
  const entity = typedEntity(
    consumerRecord({ labelled: { meta: { id: "store.main", name: "main", type: "store" }, location: "main.internal" } }),
    Consumer,
    referenceClasses,
  );

  assert.ok(entity.labelled instanceof LabelledDatabase);
  assert.equal(entity.labelled.name, "main");
  assert.equal(entity.labelled.location, "main.internal");
});

test("a reference's two label fields receive the referenced block's subtype and name", () => {
  const entity = typedEntity(consumerRecord({ subtyped: databaseValue("replica", 5) }), Consumer, referenceClasses);

  assert.ok(entity.subtyped instanceof SubtypedDatabase);
  assert.equal(entity.subtyped.kind, "postgres");
  assert.equal(entity.subtyped.title, "replica");
  assert.equal(entity.subtyped.location, "replica.internal");
});

test("a list of references becomes instances of their class in order, each holding its block's metadata", () => {
  const entity = typedEntity(consumerRecord({ databases: [databaseValue("main", 1), databaseValue("replica", 5, { port: 6432 })] }), Consumer, referenceClasses);

  assert.equal(entity.databases.length, 2);
  assert.ok(entity.databases[0] instanceof Database);
  assert.ok(entity.databases[1] instanceof Database);
  assert.equal(entity.databases[0].meta.id, "database.postgres.main");
  assert.equal(entity.databases[0].port, 5432);
  assert.equal(entity.databases[1].meta.id, "database.postgres.replica");
  assert.equal(entity.databases[1].location, "replica.internal");
  assert.equal(entity.databases[1].port, 6432);
});

test("a map of references becomes a record of instances keyed as written, each holding its block's metadata", () => {
  const entity = typedEntity(consumerRecord({ by_role: { primary: databaseValue("main", 1), standby: databaseValue("replica", 5) } }), Consumer, referenceClasses);

  assert.deepEqual(Object.keys(entity.byRole), ["primary", "standby"]);
  assert.ok(entity.byRole.primary instanceof Database);
  assert.ok(entity.byRole.standby instanceof Database);
  assert.equal(entity.byRole.primary.meta.name, "main");
  assert.equal(entity.byRole.standby.meta.name, "replica");
  assert.equal(entity.byRole.standby.location, "replica.internal");
});

test("a reference does not take the referencing entity's metadata", () => {
  const entity = typedEntity(consumerRecord(), Consumer, referenceClasses);

  assert.equal(entity.meta.id, "app.web");
  assert.equal(entity.database.meta.id, "database.postgres.main");
});
