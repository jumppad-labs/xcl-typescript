import assert from "node:assert/strict";
import { test } from "node:test";

import { Attribute, Block, Blocks, Computed, Int, Label, NamedBlocks } from "../../src/decorators.js";
import { Entity, Meta } from "../../src/entity.js";
import { NotRegisteredError, SchemaError, TypeMismatchError } from "../../src/errors.js";
import { ClassMap, GenericEntity, hydrate, sourceOf, typedEntity } from "../../src/hydrate.js";
import { registrationOf } from "../../src/schema.js";
import { Sensitive } from "../../src/sensitive.js";

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
