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
