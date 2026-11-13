/**
 * Schema derivation and registration. Every class is declared in the test that
 * uses it, and every expected document is written out by hand in the form
 * internal/schema/v1.go reads. Each refusal is asserted by its whole message,
 * so a test cannot pass because the class was refused for some other reason.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Any, Attribute, Block, Blocks, Computed, Int, Label, NamedBlocks, type EntityClass, type TypeSpec } from "../../src/decorators.js";
import { Entity, Meta } from "../../src/entity.js";
import { SchemaError } from "../../src/errors.js";
import { GitHubRegistry, LocalRegistry } from "../../src/registry.js";
import { probeOf, registrationOf } from "../../src/schema.js";
import { Sensitive } from "../../src/sensitive.js";

// The document as a whole

test("a named type's document holds its version, type and fields", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(String) image!: string;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "image", type: "string" }],
  });
});

test("a type with a subtype writes the subtype", () => {
  @Entity("database", "postgres")
  class Postgres {
    @Meta() meta!: Meta;
    @Attribute(String) location!: string;
  }

  assert.deepEqual(registrationOf(Postgres).schema, {
    schema_version: 1,
    type: "database",
    subtype: "postgres",
    fields: [{ name: "location", type: "string" }],
  });
});

test("a type with no declared fields has an empty field list", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [],
  });
});

test("field names are written in snake_case", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(String) connectionString!: string;
    @Attribute(Int) http2Port!: number;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      { name: "connection_string", type: "string" },
      { name: "http2_port", type: "number", format: "int" },
    ],
  });
});

test("the fields keep the order the class declares them in", () => {
  @Entity("app")
  class App {
    @Attribute(String) zebra!: string;
    @Meta() meta!: Meta;
    @Attribute(String) apple!: string;
    @Attribute(String) mango!: string;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      { name: "zebra", type: "string" },
      { name: "apple", type: "string" },
      { name: "mango", type: "string" },
    ],
  });
});

test("a subclass with its own @Entity holds its base's fields first", () => {
  class Base {
    @Meta() meta!: Meta;
    @Attribute(String) region!: string;
  }

  @Entity("child")
  class Child extends Base {
    @Attribute(Int) replicas!: number;
  }

  assert.deepEqual(registrationOf(Child).schema, {
    schema_version: 1,
    type: "child",
    fields: [
      { name: "region", type: "string" },
      { name: "replicas", type: "number", format: "int" },
    ],
  });
});

test("every field form together makes the document the engine's reader expects", () => {
  class Health {
    @Attribute(String) path!: string;
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
    @Attribute(String) region = "eu";
    @Sensitive(String, { optional: true }) password?: Sensitive<string>;
    @Computed(String) endpoint?: string;
    @Block(() => Health, { optional: true }) health?: Health;
    @Blocks(() => Volume) volume: Volume[] = [];
    @NamedBlocks(() => Listener) listener: Record<string, Listener> = {};
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      { name: "image", type: "string" },
      { name: "replicas", type: "number", format: "int", optional: true, default: 2 },
      { name: "region", type: "string", optional: true, default: "eu" },
      { name: "password", type: "string", optional: true, sensitive: true },
      { name: "endpoint", type: "string", computed: true, nullable: true },
      {
        name: "health",
        kind: "block",
        optional: true,
        type: { object: [{ name: "path", type: "string" }] },
      },
      {
        name: "volume",
        kind: "block",
        repeated: true,
        label: "name",
        type: { object: [{ name: "source", type: "string" }] },
      },
      {
        name: "listener",
        kind: "block",
        label: "name",
        type: { map: { object: [{ name: "port", type: "number", format: "int" }] } },
      },
    ],
  });
});

test("a registration carries the type, the subtype and the class", () => {
  @Entity("database", "postgres")
  class Postgres {
    @Meta() meta!: Meta;
  }

  const registration = registrationOf(Postgres);

  assert.equal(registration.type, "database");
  assert.equal(registration.subtype, "postgres");
  assert.equal(registration.ctor, Postgres);
});

test("a registration of a type with no subtype has an empty subtype", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
  }

  assert.equal(registrationOf(App).subtype, "");
});

// Required, optional and default attributes

test("an attribute with no initializer is required", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(String) image!: string;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "image", type: "string" }],
  });
});

test("an attribute explicitly not optional with no initializer is required", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(String, { optional: false }) image!: string;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "image", type: "string" }],
  });
});

test("an attribute initialized to null is required, as one with no initializer is", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(String) image: string | null = null;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "image", type: "string" }],
  });
});

test("an optional attribute with no initializer is optional and nullable", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(String, { optional: true }) region?: string;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "region", type: "string", optional: true, nullable: true }],
  });
});

test("an optional attribute initialized to null is optional and nullable", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(String, { optional: true }) region: string | null = null;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "region", type: "string", optional: true, nullable: true }],
  });
});

test("a string initializer makes the attribute optional with a default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(String) region = "eu";
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "region", type: "string", optional: true, default: "eu" }],
  });
});

test("an empty string initializer is a default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(String) note = "";
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "note", type: "string", optional: true, default: "" }],
  });
});

test("an integer initializer makes the attribute optional with a default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(Int) replicas = 2;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "replicas", type: "number", format: "int", optional: true, default: 2 }],
  });
});

test("a zero initializer is a default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(Int) retries = 0;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "retries", type: "number", format: "int", optional: true, default: 0 }],
  });
});

test("a float initializer makes the attribute optional with a default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(Number) ratio = 0.5;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "ratio", type: "number", format: "float", optional: true, default: 0.5 }],
  });
});

test("a true initializer makes the attribute optional with a default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(Boolean) enabled = true;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "enabled", type: "bool", optional: true, default: true }],
  });
});

test("a false initializer is a default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(Boolean) enabled = false;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "enabled", type: "bool", optional: true, default: false }],
  });
});

test("an empty array initializer makes the attribute optional with no default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute([String]) tags: string[] = [];
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "tags", type: { list: "string" }, optional: true }],
  });
});

test("an empty object initializer makes the attribute optional with no default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute({ map: String }) labels: Record<string, string> = {};
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "labels", type: { map: "string" }, optional: true }],
  });
});

test("a non-empty array initializer is a default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute([String]) tags = ["blue", "green"];
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "tags", type: { list: "string" }, optional: true, default: ["blue", "green"] }],
  });
});

test("a non-empty object initializer is a default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute({ map: String }) labels = { team: "core" };
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "labels", type: { map: "string" }, optional: true, default: { team: "core" } }],
  });
});

test("a list of Int with an initializer carries its format and default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute([Int]) ports = [80, 443];
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "ports", type: { list: "number" }, format: "int", optional: true, default: [80, 443] }],
  });
});

test("an optional attribute with an initializer has a default and is not nullable", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(String, { optional: true }) region = "eu";
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "region", type: "string", optional: true, default: "eu" }],
  });
});

test("a value the constructor assigns is a default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(String) region: string;

    constructor() {
      this.region = "eu";
    }
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "region", type: "string", optional: true, default: "eu" }],
  });
});

test("an Any attribute takes a structured initializer as its default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(Any) settings = { retries: 3, tags: ["a"] };
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "settings", type: "any", optional: true, default: { retries: 3, tags: ["a"] } }],
  });
});

// Type specs

test("String is the string type", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(String) value!: string;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: "string" }],
  });
});

test("Boolean is the bool type", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(Boolean) value!: boolean;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: "bool" }],
  });
});

test("Number is the number type in float format", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(Number) value!: number;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: "number", format: "float" }],
  });
});

test("Int is the number type in int format", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(Int) value!: number;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: "number", format: "int" }],
  });
});

test("Any is the any type", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(Any) value: unknown;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: "any" }],
  });
});

test("[String] is a list of strings", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute([String]) value!: string[];
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: { list: "string" } }],
  });
});

test("{ map: String } is a map of strings", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute({ map: String }) value!: Record<string, string>;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: { map: "string" } }],
  });
});

test("[Int] carries the int format beside the list", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute([Int]) value!: number[];
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: { list: "number" }, format: "int" }],
  });
});

test("{ map: Int } carries the int format beside the map", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute({ map: Int }) value!: Record<string, number>;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: { map: "number" }, format: "int" }],
  });
});

test("[Number] carries the float format beside the list", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute([Number]) value!: number[];
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: { list: "number" }, format: "float" }],
  });
});

test("a list of lists of Int nests the list and carries the format once", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute([[Int]]) value!: number[][];
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: { list: { list: "number" } }, format: "int" }],
  });
});

test("a map of lists nests the list within the map", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute({ map: [String] }) value!: Record<string, string[]>;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: { map: { list: "string" } } }],
  });
});

// Sensitive fields

test("a required sensitive field is sensitive, and neither optional nor nullable", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Sensitive(String) password!: Sensitive<string>;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "password", type: "string", sensitive: true }],
  });
});

test("an optional sensitive field is optional and never nullable", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Sensitive(String, { optional: true }) password?: Sensitive<string>;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "password", type: "string", optional: true, sensitive: true }],
  });
});

test("a sensitive field initialized to a Sensitive is optional with its value as the default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Sensitive(String) token = new Sensitive("development");
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "token", type: "string", optional: true, sensitive: true, default: "development" }],
  });
});

test("a Sensitive holding an empty string is a default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Sensitive(String) token = new Sensitive("");
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "token", type: "string", optional: true, sensitive: true, default: "" }],
  });
});

test("a Sensitive holding an empty list is optional with no default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Sensitive([String]) tokens = new Sensitive<string[]>([]);
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "tokens", type: { list: "string" }, optional: true, sensitive: true }],
  });
});

test("a redacted Sensitive initializer gives no default and leaves the field required", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Sensitive(String) token = Sensitive.redacted<string>();
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "token", type: "string", sensitive: true }],
  });
});

test("a sensitive field may be a Number in float format", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Sensitive(Number) value!: Sensitive<number>;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: "number", format: "float", sensitive: true }],
  });
});

test("a sensitive field may be an Int in int format", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Sensitive(Int) value!: Sensitive<number>;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: "number", format: "int", sensitive: true }],
  });
});

test("a sensitive field may be a Boolean", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Sensitive(Boolean) value!: Sensitive<boolean>;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: "bool", sensitive: true }],
  });
});

test("a sensitive field may be a list of strings", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Sensitive([String]) value!: Sensitive<string[]>;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: { list: "string" }, sensitive: true }],
  });
});

test("a sensitive field may be a map of strings", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Sensitive({ map: String }) value!: Sensitive<Record<string, string>>;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "value", type: { map: "string" }, sensitive: true }],
  });
});

// Computed fields

test("a computed field is computed and nullable, never optional", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Computed(String) endpoint?: string;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "endpoint", type: "string", computed: true, nullable: true }],
  });
});

test("a computed Int carries its format", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Computed(Int) port?: number;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "port", type: "number", format: "int", computed: true, nullable: true }],
  });
});

test("a computed list is computed and nullable", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Computed([String]) addresses?: string[];
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "addresses", type: { list: "string" }, computed: true, nullable: true }],
  });
});

test("a computed field's initializer is not a default", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Computed(String) endpoint = "pending";
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "endpoint", type: "string", computed: true, nullable: true }],
  });
});

// Blocks

test("a required block is a block of an object, not optional", () => {
  class Health {
    @Attribute(String) path!: string;
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Block(() => Health) health!: Health;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "health",
        kind: "block",
        type: { object: [{ name: "path", type: "string" }] },
      },
    ],
  });
});

test("an optional block is optional", () => {
  class Health {
    @Attribute(String) path!: string;
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Block(() => Health, { optional: true }) health?: Health;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "health",
        kind: "block",
        optional: true,
        type: { object: [{ name: "path", type: "string" }] },
      },
    ],
  });
});

test("an initialized block is optional", () => {
  class Health {
    @Attribute(String) path = "/";
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Block(() => Health) health = new Health();
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "health",
        kind: "block",
        optional: true,
        type: { object: [{ name: "path", type: "string", optional: true, default: "/" }] },
      },
    ],
  });
});

test("a list of blocks is repeated and not optional", () => {
  class Volume {
    @Attribute(String) source!: string;
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Blocks(() => Volume) volume!: Volume[];
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "volume",
        kind: "block",
        repeated: true,
        type: { object: [{ name: "source", type: "string" }] },
      },
    ],
  });
});

test("an empty initializer leaves a list of blocks not optional", () => {
  class Volume {
    @Attribute(String) source!: string;
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Blocks(() => Volume) volume: Volume[] = [];
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "volume",
        kind: "block",
        repeated: true,
        type: { object: [{ name: "source", type: "string" }] },
      },
    ],
  });
});

test("a non-empty initializer on a list of blocks writes no default", () => {
  class Volume {
    @Attribute(String) source = "/data";
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Blocks(() => Volume) volume = [new Volume()];
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "volume",
        kind: "block",
        repeated: true,
        type: { object: [{ name: "source", type: "string", optional: true, default: "/data" }] },
      },
    ],
  });
});

test("named blocks are a map of an object and not optional", () => {
  class Listener {
    @Attribute(Int) port!: number;
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @NamedBlocks(() => Listener) listener!: Record<string, Listener>;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "listener",
        kind: "block",
        type: { map: { object: [{ name: "port", type: "number", format: "int" }] } },
      },
    ],
  });
});

test("an empty initializer leaves named blocks not optional", () => {
  class Listener {
    @Attribute(Int) port!: number;
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @NamedBlocks(() => Listener) listener: Record<string, Listener> = {};
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "listener",
        kind: "block",
        type: { map: { object: [{ name: "port", type: "number", format: "int" }] } },
      },
    ],
  });
});

test("a list element's label field is named by label and dropped from its fields", () => {
  class Volume {
    @Label() name!: string;
    @Attribute(String) source!: string;
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Blocks(() => Volume) volume: Volume[] = [];
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "volume",
        kind: "block",
        repeated: true,
        label: "name",
        type: { object: [{ name: "source", type: "string" }] },
      },
    ],
  });
});

test("a named block's label field is named by label and dropped from its fields", () => {
  class Listener {
    @Label() name!: string;
    @Attribute(Int) port!: number;
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @NamedBlocks(() => Listener) listener: Record<string, Listener> = {};
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "listener",
        kind: "block",
        label: "name",
        type: { map: { object: [{ name: "port", type: "number", format: "int" }] } },
      },
    ],
  });
});

test("a single block's label field is named by label and dropped from its fields", () => {
  class Health {
    @Label() name!: string;
    @Attribute(String) path!: string;
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Block(() => Health) health!: Health;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "health",
        kind: "block",
        label: "name",
        type: { object: [{ name: "path", type: "string" }] },
      },
    ],
  });
});

test("a label is written in snake_case", () => {
  class Volume {
    @Label() volumeName!: string;
    @Attribute(String) source!: string;
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Blocks(() => Volume) volume: Volume[] = [];
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "volume",
        kind: "block",
        repeated: true,
        label: "volume_name",
        type: { object: [{ name: "source", type: "string" }] },
      },
    ],
  });
});

test("a block's element holds every attribute form", () => {
  class Connection {
    @Attribute(String) host!: string;
    @Attribute(Int) port = 5432;
    @Attribute(String, { optional: true }) database?: string;
    @Sensitive(String, { optional: true }) password?: Sensitive<string>;
    @Computed(String) resolved?: string;
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Block(() => Connection) connection!: Connection;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "connection",
        kind: "block",
        type: {
          object: [
            { name: "host", type: "string" },
            { name: "port", type: "number", format: "int", optional: true, default: 5432 },
            { name: "database", type: "string", optional: true, nullable: true },
            { name: "password", type: "string", optional: true, sensitive: true },
            { name: "resolved", type: "string", computed: true, nullable: true },
          ],
        },
      },
    ],
  });
});

test("a block's element may hold further blocks", () => {
  class Probe {
    @Attribute(String) path!: string;
  }

  class Health {
    @Block(() => Probe) probe!: Probe;
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Block(() => Health) health!: Health;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "health",
        kind: "block",
        type: {
          object: [
            {
              name: "probe",
              kind: "block",
              type: { object: [{ name: "path", type: "string" }] },
            },
          ],
        },
      },
    ],
  });
});

test("one class may be used by two sibling blocks", () => {
  class Health {
    @Attribute(String) path!: string;
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Block(() => Health) liveness!: Health;
    @Block(() => Health) readiness!: Health;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "liveness",
        kind: "block",
        type: { object: [{ name: "path", type: "string" }] },
      },
      {
        name: "readiness",
        kind: "block",
        type: { object: [{ name: "path", type: "string" }] },
      },
    ],
  });
});

test("a block's element may use the names every top-level block reserves", () => {
  class Task {
    @Attribute(String) meta!: string;
    @Attribute(Boolean) disabled!: boolean;
    @Attribute([String]) dependsOn!: string[];
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Block(() => Task) task!: Task;
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "task",
        kind: "block",
        type: {
          object: [
            { name: "meta", type: "string" },
            { name: "disabled", type: "bool" },
            { name: "depends_on", type: { list: "string" } },
          ],
        },
      },
    ],
  });
});

// Singletons and labels

test("a class with neither a label field nor a metadata field is a singleton", () => {
  @Entity("runner")
  class Runner {
    @Attribute(String) server!: string;
  }

  assert.deepEqual(registrationOf(Runner).schema, {
    schema_version: 1,
    type: "runner",
    singleton: true,
    fields: [{ name: "server", type: "string" }],
  });
});

test("a class with a metadata field and no label field is not a singleton", () => {
  @Entity("agent")
  class Agent {
    @Meta() meta!: Meta;
    @Attribute(String) model!: string;
  }

  assert.deepEqual(registrationOf(Agent).schema, {
    schema_version: 1,
    type: "agent",
    fields: [{ name: "model", type: "string" }],
  });
});

test("a class with a label field and no metadata field is not a singleton", () => {
  @Entity("agent")
  class Agent {
    @Label() name!: string;
    @Attribute(String) model!: string;
  }

  assert.deepEqual(registrationOf(Agent).schema, {
    schema_version: 1,
    type: "agent",
    fields: [{ name: "model", type: "string" }],
  });
});

test("a class with a label field and a metadata field is not a singleton", () => {
  @Entity("agent")
  class Agent {
    @Meta() meta!: Meta;
    @Label() name!: string;
    @Attribute(String) model!: string;
  }

  assert.deepEqual(registrationOf(Agent).schema, {
    schema_version: 1,
    type: "agent",
    fields: [{ name: "model", type: "string" }],
  });
});

test("two label fields with a subtype are accepted and fill no fields", () => {
  @Entity("database", "postgres")
  class Postgres {
    @Label() kind!: string;
    @Label() name!: string;
    @Attribute(String) location!: string;
  }

  assert.deepEqual(registrationOf(Postgres).schema, {
    schema_version: 1,
    type: "database",
    subtype: "postgres",
    fields: [{ name: "location", type: "string" }],
  });
});

test("a subtype with a metadata field and no label fields is accepted", () => {
  @Entity("database", "postgres")
  class Postgres {
    @Meta() meta!: Meta;
    @Attribute(String) location!: string;
  }

  assert.deepEqual(registrationOf(Postgres).schema, {
    schema_version: 1,
    type: "database",
    subtype: "postgres",
    fields: [{ name: "location", type: "string" }],
  });
});

test("a subtype on a singleton is refused", () => {
  @Entity("runner", "fast")
  class Runner {
    @Attribute(String) server!: string;
  }

  assert.throws(
    () => new LocalRegistry().register(Runner),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "Runner has no label field and no metadata field, so its block is written without labels, and its type takes no subtype");
      return true;
    },
  );
});

test("two label fields without a subtype are refused", () => {
  @Entity("app")
  class Broken {
    @Label() first!: string;
    @Label() second!: string;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "Broken has 2 label fields, a block of its type has 1 labels");
      return true;
    },
  );
});

test("one label field with a subtype is refused", () => {
  @Entity("database", "postgres")
  class Broken {
    @Label() name!: string;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "Broken has 1 label fields, a block of its type has 2 labels");
      return true;
    },
  );
});

test("three label fields with a subtype are refused", () => {
  @Entity("database", "postgres")
  class Broken {
    @Label() first!: string;
    @Label() second!: string;
    @Label() third!: string;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "Broken has 3 label fields, a block of its type has 2 labels");
      return true;
    },
  );
});

test("a nested block with two label fields is refused", () => {
  class Volume {
    @Label() first!: string;
    @Label() second!: string;
  }

  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Blocks(() => Volume) volume: Volume[] = [];
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.volume: Volume has 2 label fields, a nested block has one label");
      return true;
    },
  );
});

// The name rule

test("an attribute named _private is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(String) _private!: string;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken._private: the name does not survive conversion to configuration and back; use a camelCase name");
      return true;
    },
  );
});

test("an attribute named already_snake is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(String) already_snake!: string;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.already_snake: the name does not survive conversion to configuration and back; use a camelCase name");
      return true;
    },
  );
});

test("a sensitive field named _private is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Sensitive(String) _private!: Sensitive<string>;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken._private: the name does not survive conversion to configuration and back; use a camelCase name");
      return true;
    },
  );
});

test("a computed field named already_snake is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Computed(String) already_snake?: string;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.already_snake: the name does not survive conversion to configuration and back; use a camelCase name");
      return true;
    },
  );
});

test("a block field named already_snake is refused", () => {
  class Health {
    @Attribute(String) path!: string;
  }

  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Block(() => Health) already_snake!: Health;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.already_snake: the name does not survive conversion to configuration and back; use a camelCase name");
      return true;
    },
  );
});

test("a label field named _private is refused", () => {
  @Entity("app")
  class Broken {
    @Label() _private!: string;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken._private: the name does not survive conversion to configuration and back; use a camelCase name");
      return true;
    },
  );
});

test("a metadata field named _private is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() _private!: Meta;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken._private: the name does not survive conversion to configuration and back; use a camelCase name");
      return true;
    },
  );
});

test("a nested block's field named _private is refused, naming the nested class", () => {
  class Inner {
    @Attribute(String) _private!: string;
  }

  @Entity("app")
  class Outer {
    @Meta() meta!: Meta;
    @Block(() => Inner) inner!: Inner;
  }

  assert.throws(
    () => new LocalRegistry().register(Outer),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Inner._private: the name does not survive conversion to configuration and back; use a camelCase name");
      return true;
    },
  );
});

test("an attribute named Meta, starting with an upper-case letter, is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(String) Meta!: string;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.Meta: the name does not survive conversion to configuration and back; use a camelCase name");
      return true;
    },
  );
});

test("an attribute named AB, starting with an upper-case letter, is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(String) AB!: string;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.AB: the name does not survive conversion to configuration and back; use a camelCase name");
      return true;
    },
  );
});

// Initializers that disagree with their decorators

test('@Attribute(Int) with the initializer "2" is refused', () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(Int) x = "2";
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("@Attribute(Int) with the initializer 1.5 is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(Int) x = 1.5;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("@Attribute(String) with the initializer 1 is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(String) x = 1;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test('@Attribute(Boolean) with the initializer "no" is refused', () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(Boolean) x = "no";
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test('@Attribute(Number) with the initializer "1" is refused', () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(Number) x = "1";
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("@Attribute([String]) with the initializer [1] is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute([String]) x = [1];
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("@Attribute([String]) with a string initializer is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute([String]) x = "a";
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test('@Attribute({ map: Int }) with the initializer { a: "b" } is refused', () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute({ map: Int }) x = { a: "b" };
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("@Attribute({ map: Int }) with an array initializer is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute({ map: Int }) x = [1];
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("a block initialized with something that is not its class is refused", () => {
  class Health {
    @Attribute(String) path = "/";
  }

  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Block(() => Health) health = { path: "/" };
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.health: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("a block initialized with an instance of another class is refused", () => {
  class Health {
    @Attribute(String) path = "/";
  }

  class Other {
    @Attribute(String) path = "/";
  }

  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Block(() => Health) health = new Other();
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.health: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("a list of blocks initialized with something that is not an array is refused", () => {
  class Volume {
    @Attribute(String) source = "/data";
  }

  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Blocks(() => Volume) volume = new Volume();
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.volume: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("named blocks initialized with an array are refused", () => {
  class Listener {
    @Attribute(Int) port = 80;
  }

  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @NamedBlocks(() => Listener) listener = [new Listener()];
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.listener: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("named blocks initialized with a string are refused", () => {
  class Listener {
    @Attribute(Int) port = 80;
  }

  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @NamedBlocks(() => Listener) listener = "web";
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.listener: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("a plain string initializer on a sensitive field is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Sensitive(String) password = "s3cret";
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.password: a sensitive field's initializer must be a Sensitive value");
      return true;
    },
  );
});

test("a Sensitive initializer holding the wrong type is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Sensitive(Int) port = new Sensitive(1.5);
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.port: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("an Any default that JSON cannot write is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(Any) x = 1n;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its default cannot be written as configuration");
      return true;
    },
  );
});

test("a disagreeing initializer on a nested block's field is refused, naming the nested class", () => {
  class Inner {
    @Attribute(Int) x = "2";
  }

  @Entity("app")
  class Outer {
    @Meta() meta!: Meta;
    @Block(() => Inner) inner!: Inner;
  }

  assert.throws(
    () => new LocalRegistry().register(Outer),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Inner.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("@Attribute(Int) with a bigint initializer is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(Int) x = 1n;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("@Attribute(Number) with the initializer NaN is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(Number) x = NaN;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("@Attribute(Number) with the initializer Infinity is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(Number) x = Infinity;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("a Sensitive initializer of the wrong type is refused without its secret in the message", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Sensitive(Int) x = new Sensitive("hunter2");
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      assert.doesNotMatch(error.message, /hunter2/);
      return true;
    },
  );
});

test("@Computed(Int) with a string initializer is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Computed(Int) x = "a";
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("a list of blocks initialized with an element that is not its class is refused", () => {
  class Volume {
    @Attribute(String) source = "/data";
  }

  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Blocks(() => Volume) x = ["a"];
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("named blocks initialized with a value that is not their class are refused", () => {
  class Listener {
    @Attribute(Int) port = 80;
  }

  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @NamedBlocks(() => Listener) x = { a: 1 };
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("a list of blocks initialized with elements of its class is accepted", () => {
  class Volume {
    @Attribute(String) source = "/data";
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Blocks(() => Volume) volume = [new Volume(), new Volume()];
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "volume",
        kind: "block",
        repeated: true,
        type: { object: [{ name: "source", type: "string", optional: true, default: "/data" }] },
      },
    ],
  });
});

test("named blocks initialized with values of their class are accepted", () => {
  class Listener {
    @Attribute(Int) port = 80;
  }

  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @NamedBlocks(() => Listener) listener = { web: new Listener(), admin: new Listener() };
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [
      {
        name: "listener",
        kind: "block",
        type: { map: { object: [{ name: "port", type: "number", format: "int", optional: true, default: 80 }] } },
      },
    ],
  });
});

// Construction

test("probeOf returns an instance of the class", () => {
  class Plain {
    value = "built";
  }

  const probe = probeOf(Plain);

  assert.ok(probe instanceof Plain);
  assert.equal(probe.value, "built");
});

test("a class whose constructor argument has a default is accepted", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(String) region: string;

    constructor(region = "eu") {
      this.region = region;
    }
  }

  assert.deepEqual(registrationOf(App).schema, {
    schema_version: 1,
    type: "app",
    fields: [{ name: "region", type: "string", optional: true, default: "eu" }],
  });
});

test("a class requiring a constructor argument is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(String) region: string;

    constructor(region: string) {
      this.region = region;
    }
  }

  assert.throws(
    () => new LocalRegistry().register(Broken as unknown as EntityClass),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "Broken cannot be constructed with no arguments; an entity class takes no constructor arguments");
      return true;
    },
  );
});

test("a class whose constructor throws is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;

    constructor() {
      throw new Error("no database");
    }
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "Broken cannot be constructed with no arguments: no database");
      return true;
    },
  );
});

test("the refusal of a throwing constructor keeps what it threw as the cause", () => {
  const thrown = new Error("no database");

  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;

    constructor() {
      throw thrown;
    }
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.cause, thrown);
      return true;
    },
  );
});

test("a class whose constructor throws something that is not an Error is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;

    constructor() {
      throw "no database";
    }
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "Broken cannot be constructed with no arguments: no database");
      return true;
    },
  );
});

test("a nested block's class requiring a constructor argument is refused", () => {
  class Inner {
    @Attribute(String) region: string;

    constructor(region: string) {
      this.region = region;
    }
  }

  @Entity("app")
  class Outer {
    @Meta() meta!: Meta;
    @Block(() => Inner as unknown as EntityClass) inner?: Inner;
  }

  assert.throws(
    () => new LocalRegistry().register(Outer),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "Inner cannot be constructed with no arguments; an entity class takes no constructor arguments");
      return true;
    },
  );
});

test("a nested block's class whose constructor throws is refused", () => {
  class Inner {
    @Attribute(String) region = "eu";

    constructor() {
      throw new Error("no database");
    }
  }

  @Entity("app")
  class Outer {
    @Meta() meta!: Meta;
    @Block(() => Inner, { optional: true }) inner?: Inner;
  }

  assert.throws(
    () => new LocalRegistry().register(Outer),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "Inner cannot be constructed with no arguments: no database");
      return true;
    },
  );
});

test("something that is not a class is refused", () => {
  assert.throws(
    () => new LocalRegistry().register("app" as unknown as EntityClass),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "app is not a class, so it cannot describe an entity type");
      return true;
    },
  );
});

// Sensitive fields of a type the engine cannot hold

test("a sensitive field of type Any is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Sensitive(Any) value!: Sensitive<unknown>;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.value: a sensitive value of this type cannot be held by the engine; sensitive values may be String, Number, Int, Boolean, [String] or { map: String }");
      return true;
    },
  );
});

test("a sensitive field of type [Int] is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Sensitive([Int]) value!: Sensitive<number[]>;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.value: a sensitive value of this type cannot be held by the engine; sensitive values may be String, Number, Int, Boolean, [String] or { map: String }");
      return true;
    },
  );
});

test("a sensitive field of type { map: Int } is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Sensitive({ map: Int }) value!: Sensitive<Record<string, number>>;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.value: a sensitive value of this type cannot be held by the engine; sensitive values may be String, Number, Int, Boolean, [String] or { map: String }");
      return true;
    },
  );
});

test("a sensitive field of type [[String]] is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Sensitive([[String]]) value!: Sensitive<string[][]>;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.value: a sensitive value of this type cannot be held by the engine; sensitive values may be String, Number, Int, Boolean, [String] or { map: String }");
      return true;
    },
  );
});

// Entity names

test("a class with no @Entity is refused", () => {
  class Broken {
    @Attribute(String) image!: string;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, 'Broken has no entity type; decorate the class itself with @Entity("type")');
      return true;
    },
  );
});

test("a subclass of an @Entity class without its own @Entity is refused", () => {
  @Entity("app")
  class Base {
    @Meta() meta!: Meta;
  }

  class Child extends Base {
    @Attribute(String) image!: string;
  }

  assert.throws(
    () => new LocalRegistry().register(Child),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, 'Child has no entity type; decorate the class itself with @Entity("type")');
      return true;
    },
  );
});

test("an @Entity with an empty type is refused", () => {
  @Entity("")
  class Broken {
    @Meta() meta!: Meta;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, 'Broken must name its entity type, such as @Entity("app")');
      return true;
    },
  );
});

// Reserved names

test("an attribute named disabled is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(Boolean) disabled!: boolean;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, 'field Broken.disabled: "disabled" is held by every block and cannot be declared; read it from the @Meta field');
      return true;
    },
  );
});

test("an attribute named dependsOn is refused as depends_on", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute([String]) dependsOn!: string[];
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, 'field Broken.dependsOn: "depends_on" is held by every block and cannot be declared; read it from the @Meta field');
      return true;
    },
  );
});

test("an attribute named meta is refused", () => {
  @Entity("app")
  class Broken {
    @Attribute(String) meta!: string;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, 'field Broken.meta: "meta" is held by every block and cannot be declared; read it from the @Meta field');
      return true;
    },
  );
});

test("a computed field named disabled is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Computed(Boolean) disabled?: boolean;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, 'field Broken.disabled: "disabled" is held by every block and cannot be declared; read it from the @Meta field');
      return true;
    },
  );
});

// Nested metadata and self-containing blocks

test("@Meta on a nested block is refused", () => {
  class Inner {
    @Meta() meta!: Meta;
  }

  @Entity("app")
  class Outer {
    @Meta() meta!: Meta;
    @Block(() => Inner) inner!: Inner;
  }

  assert.throws(
    () => new LocalRegistry().register(Outer),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Inner.meta: a nested block has no metadata; @Meta belongs on an entity class");
      return true;
    },
  );
});

test("an entity class holding itself as a block is refused", () => {
  @Entity("tree")
  class Tree {
    @Meta() meta!: Meta;
    @Block(() => Tree, { optional: true }) child?: Tree;
  }

  assert.throws(
    () => new LocalRegistry().register(Tree),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Tree.child: Tree contains itself, which configuration cannot write");
      return true;
    },
  );
});

test("a nested block holding itself as a block is refused", () => {
  class Node {
    @Block(() => Node, { optional: true }) next?: Node;
  }

  @Entity("list")
  class Holder {
    @Meta() meta!: Meta;
    @Block(() => Node) head!: Node;
  }

  assert.throws(
    () => new LocalRegistry().register(Holder),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Node.next: Node contains itself, which configuration cannot write");
      return true;
    },
  );
});

test("a block holding itself in a list of blocks is refused", () => {
  class Node {
    @Blocks(() => Node) children: Node[] = [];
  }

  @Entity("tree")
  class Holder {
    @Meta() meta!: Meta;
    @Block(() => Node) root!: Node;
  }

  assert.throws(
    () => new LocalRegistry().register(Holder),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Node.children: Node contains itself, which configuration cannot write");
      return true;
    },
  );
});

test("a block holding itself in named blocks is refused", () => {
  class Node {
    @NamedBlocks(() => Node) children: Record<string, Node> = {};
  }

  @Entity("tree")
  class Holder {
    @Meta() meta!: Meta;
    @Block(() => Node) root!: Node;
  }

  assert.throws(
    () => new LocalRegistry().register(Holder),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Node.children: Node contains itself, which configuration cannot write");
      return true;
    },
  );
});

test("two blocks containing each other are refused", () => {
  class First {
    @Block(() => Second, { optional: true }) second?: Second;
  }

  class Second {
    @Block(() => First, { optional: true }) first?: First;
  }

  @Entity("pair")
  class Holder {
    @Meta() meta!: Meta;
    @Block(() => First) first!: First;
  }

  assert.throws(
    () => new LocalRegistry().register(Holder),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Second.first: First contains itself, which configuration cannot write");
      return true;
    },
  );
});

test("a block's thunk that returns no class is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Block(() => undefined as unknown as EntityClass) health?: object;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.health: its block must be given as a function returning a class, such as () => Health");
      return true;
    },
  );
});

test("a block given as a class rather than a thunk is refused", () => {
  class Health {
    @Attribute(String) path = "/";
  }

  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Block(Health as unknown as () => EntityClass) health?: Health;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.health: its block must be given as a function returning a class, such as () => Health");
      return true;
    },
  );
});

test("a block's thunk that throws is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Block(() => {
      throw new ReferenceError("Health is not defined");
    })
    health?: object;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.health: its block must be given as a function returning a class, such as () => Health");
      return true;
    },
  );
});

test("the refusal of a thunk that throws keeps what it threw as the cause", () => {
  const thrown = new ReferenceError("Health is not defined");

  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Block(() => {
      throw thrown;
    })
    health?: object;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.cause, thrown);
      return true;
    },
  );
});

// Type specs with no configuration form

test("a class given as an attribute's type is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(Date as unknown as TypeSpec) x!: Date;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: this type has no configuration form; use String, Number, Boolean, Int, Any, [T] or { map: T }");
      return true;
    },
  );
});

test("a type name given as a string is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute("string" as unknown as TypeSpec) x!: string;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: this type has no configuration form; use String, Number, Boolean, Int, Any, [T] or { map: T }");
      return true;
    },
  );
});

test("an empty array as a type is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute([] as unknown as TypeSpec) x!: string[];
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: this type has no configuration form; use String, Number, Boolean, Int, Any, [T] or { map: T }");
      return true;
    },
  );
});

test("an array of two types as a type is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute([String, Int] as unknown as TypeSpec) x!: string[];
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: this type has no configuration form; use String, Number, Boolean, Int, Any, [T] or { map: T }");
      return true;
    },
  );
});

test("an unrecognised element type of a list is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute([Date] as unknown as TypeSpec) x!: Date[];
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: this type has no configuration form; use String, Number, Boolean, Int, Any, [T] or { map: T }");
      return true;
    },
  );
});

test("an unrecognised element type of a map is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute({ map: Date } as unknown as TypeSpec) x!: Record<string, Date>;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: this type has no configuration form; use String, Number, Boolean, Int, Any, [T] or { map: T }");
      return true;
    },
  );
});

test("an unrecognised type on a computed field is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Computed(Date as unknown as TypeSpec) x?: Date;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: this type has no configuration form; use String, Number, Boolean, Int, Any, [T] or { map: T }");
      return true;
    },
  );
});

test("an unrecognised type on a sensitive field is refused", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Sensitive(Date as unknown as TypeSpec) x!: Sensitive<Date>;
  }

  assert.throws(
    () => new LocalRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: this type has no configuration form; use String, Number, Boolean, Int, Any, [T] or { map: T }");
      return true;
    },
  );
});

// Registries

test("a local registry declares each registered class with its schema", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(String) image!: string;
  }

  @Entity("database", "postgres")
  class Postgres {
    @Meta() meta!: Meta;
    @Attribute(Int) port = 5432;
  }

  const registry = new LocalRegistry();

  registry.register(App, Postgres);

  const message = registry.toProto();
  assert.ok(message.kind?.case === "local");
  const declared = message.kind.value.types ?? [];
  assert.equal(declared.length, 2);
  assert.equal(declared[0]?.type, "app");
  assert.equal(declared[0]?.subtype, "");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(declared[0]?.schema)), {
    schema_version: 1,
    type: "app",
    fields: [{ name: "image", type: "string" }],
  });
  assert.equal(declared[1]?.type, "database");
  assert.equal(declared[1]?.subtype, "postgres");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(declared[1]?.schema)), {
    schema_version: 1,
    type: "database",
    subtype: "postgres",
    fields: [{ name: "port", type: "number", format: "int", optional: true, default: 5432 }],
  });
});

test("a GitHub registry declares each registered class with its schema", () => {
  @Entity("app")
  class App {
    @Meta() meta!: Meta;
    @Attribute(String) image!: string;
  }

  @Entity("database", "postgres")
  class Postgres {
    @Meta() meta!: Meta;
    @Attribute(Int) port = 5432;
  }

  const registry = new GitHubRegistry();

  registry.register(App, Postgres);

  const message = registry.toProto();
  assert.ok(message.kind?.case === "github");
  const declared = message.kind.value.types ?? [];
  assert.equal(declared.length, 2);
  assert.equal(declared[0]?.type, "app");
  assert.equal(declared[0]?.subtype, "");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(declared[0]?.schema)), {
    schema_version: 1,
    type: "app",
    fields: [{ name: "image", type: "string" }],
  });
  assert.equal(declared[1]?.type, "database");
  assert.equal(declared[1]?.subtype, "postgres");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(declared[1]?.schema)), {
    schema_version: 1,
    type: "database",
    subtype: "postgres",
    fields: [{ name: "port", type: "number", format: "int", optional: true, default: 5432 }],
  });
});

test("a local registry adds to its types over several register calls", () => {
  @Entity("first")
  class First {
    @Meta() meta!: Meta;
  }

  @Entity("second")
  class Second {
    @Meta() meta!: Meta;
  }

  const registry = new LocalRegistry();

  registry.register(First);
  registry.register(Second);

  assert.deepEqual(
    registry.registrations.map((registration) => registration.type),
    ["first", "second"],
  );
});

test("a GitHub registry adds to its types over several register calls", () => {
  @Entity("first")
  class First {
    @Meta() meta!: Meta;
  }

  @Entity("second")
  class Second {
    @Meta() meta!: Meta;
  }

  const registry = new GitHubRegistry();

  registry.register(First);
  registry.register(Second);

  assert.deepEqual(
    registry.registrations.map((registration) => registration.type),
    ["first", "second"],
  );
});

test("a GitHub registry refuses what a local registry refuses", () => {
  @Entity("app")
  class Broken {
    @Meta() meta!: Meta;
    @Attribute(Int) x = "2";
  }

  assert.throws(
    () => new GitHubRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, "field Broken.x: its initializer disagrees with its decorator");
      return true;
    },
  );
});

test("a GitHub registry refuses a class with no @Entity", () => {
  class Broken {
    @Attribute(String) image!: string;
  }

  assert.throws(
    () => new GitHubRegistry().register(Broken),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.message, 'Broken has no entity type; decorate the class itself with @Entity("type")');
      return true;
    },
  );
});
