/**
 * One suite, compiled twice: tsconfig.decorators-standard.json and
 * tsconfig.decorators-legacy.json each build it, and the same hand-written
 * expected tables must hold against both outputs. Each test constructs a class
 * before reading its fields, as registration does: a standard decorator fills
 * the table only when an instance is built.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Any, entityNameOf, fieldsOf, Int, type FieldSpec } from "../../src/decorators.js";
import {
  App,
  BaseResource,
  ChildResource,
  ConstructedTwice,
  DeclaredLater,
  ForwardReference,
  GrandchildResource,
  Health,
  Listener,
  OptionalFlags,
  OverridingResource,
  Postgres,
  TypeSpecs,
  Volume,
} from "./entities.js";

const compileMode = import.meta.url.includes("decorators-legacy") ? "legacy" : "standard";

/** The fields with each block thunk replaced by the class it returns, so tables compare by value. */
function withBlocksResolved(fields: FieldSpec[]): object[] {
  return fields.map((field) => {
    if (field.block === undefined) {
      return field;
    }
    return { ...field, block: field.block() };
  });
}

function fieldNamed(fields: FieldSpec[], property: string): FieldSpec {
  const field = fields.find((candidate) => candidate.property === property);
  assert.ok(field !== undefined, `no field named ${property}`);
  return field;
}

describe(`entity decorators under ${compileMode} decorators`, () => {
  test("App records every field in declaration order", () => {
    new App();

    assert.deepEqual(withBlocksResolved(fieldsOf(App)), [
      { property: "meta", kind: "meta" },
      { property: "image", kind: "attribute", type: String, optional: false },
      { property: "replicas", kind: "attribute", type: Int, optional: false },
      { property: "region", kind: "attribute", type: String, optional: true },
      { property: "password", kind: "sensitive", type: String, optional: true },
      { property: "endpoint", kind: "computed", type: String },
      { property: "health", kind: "block", block: Health, optional: true },
      { property: "volume", kind: "blocks", block: Volume },
      { property: "listener", kind: "namedBlocks", block: Listener },
    ]);
  });

  test("Postgres, an entity with a subtype, records its fields", () => {
    new Postgres();

    assert.deepEqual(fieldsOf(Postgres), [
      { property: "meta", kind: "meta" },
      { property: "location", kind: "attribute", type: String, optional: false },
      { property: "port", kind: "attribute", type: Int, optional: false },
    ]);
  });

  test("Health, a block class with no class decorator, records its attributes", () => {
    new Health();

    assert.deepEqual(fieldsOf(Health), [
      { property: "path", kind: "attribute", type: String, optional: false },
      { property: "interval", kind: "attribute", type: Int, optional: false },
    ]);
  });

  test("Volume, a block class with no class decorator, records its label", () => {
    new Volume();

    assert.deepEqual(fieldsOf(Volume), [
      { property: "name", kind: "label" },
      { property: "source", kind: "attribute", type: String, optional: false },
    ]);
  });

  test("Listener, a block class with no class decorator, records its label", () => {
    new Listener();

    assert.deepEqual(fieldsOf(Listener), [
      { property: "name", kind: "label" },
      { property: "port", kind: "attribute", type: Int, optional: false },
    ]);
  });

  test("every type a field can have is recorded as written", () => {
    new TypeSpecs();

    assert.deepEqual(fieldsOf(TypeSpecs), [
      { property: "text", kind: "attribute", type: String, optional: false },
      { property: "ratio", kind: "attribute", type: Number, optional: false },
      { property: "enabled", kind: "attribute", type: Boolean, optional: false },
      { property: "count", kind: "attribute", type: Int, optional: false },
      { property: "anything", kind: "attribute", type: Any, optional: false },
      { property: "tags", kind: "attribute", type: [String], optional: false },
      { property: "labels", kind: "attribute", type: { map: String }, optional: false },
      { property: "grid", kind: "attribute", type: [[Int]], optional: false },
      { property: "groups", kind: "attribute", type: { map: [String] }, optional: false },
      { property: "addresses", kind: "computed", type: [String] },
      { property: "credentials", kind: "sensitive", type: { map: String }, optional: false },
    ]);
  });

  test("an attribute given no options is recorded as not optional", () => {
    new OptionalFlags();

    assert.equal(fieldNamed(fieldsOf(OptionalFlags), "defaultAttribute").optional, false);
  });

  test("an attribute given optional false is recorded as not optional", () => {
    new OptionalFlags();

    assert.equal(fieldNamed(fieldsOf(OptionalFlags), "requiredAttribute").optional, false);
  });

  test("an attribute given optional true is recorded as optional", () => {
    new OptionalFlags();

    assert.equal(fieldNamed(fieldsOf(OptionalFlags), "optionalAttribute").optional, true);
  });

  test("a sensitive field given no options is recorded as not optional", () => {
    new OptionalFlags();

    assert.equal(fieldNamed(fieldsOf(OptionalFlags), "defaultSecret").optional, false);
  });

  test("a sensitive field given optional true is recorded as optional", () => {
    new OptionalFlags();

    assert.equal(fieldNamed(fieldsOf(OptionalFlags), "optionalSecret").optional, true);
  });

  test("a block given no options is recorded as not optional", () => {
    new OptionalFlags();

    assert.equal(fieldNamed(fieldsOf(OptionalFlags), "defaultBlock").optional, false);
  });

  test("a block given optional true is recorded as optional", () => {
    new OptionalFlags();

    assert.equal(fieldNamed(fieldsOf(OptionalFlags), "optionalBlock").optional, true);
  });

  test("block thunks resolve to a class declared after the field that names it", () => {
    new ForwardReference();

    assert.deepEqual(withBlocksResolved(fieldsOf(ForwardReference)), [
      { property: "later", kind: "block", block: DeclaredLater, optional: false },
      { property: "many", kind: "blocks", block: DeclaredLater },
      { property: "named", kind: "namedBlocks", block: DeclaredLater },
    ]);
  });

  test("constructing an instance twice leaves the table the same", () => {
    new ConstructedTwice();
    const afterOneInstance = fieldsOf(ConstructedTwice);

    new ConstructedTwice();
    const afterTwoInstances = fieldsOf(ConstructedTwice);

    assert.deepEqual(afterOneInstance, [
      { property: "first", kind: "attribute", type: String, optional: false },
      { property: "second", kind: "attribute", type: Int, optional: false },
    ]);
    assert.deepEqual(afterTwoInstances, afterOneInstance);
  });

  test("entityNameOf gives App its type and an empty subtype", () => {
    assert.deepEqual(entityNameOf(App), { type: "app", subtype: "" });
  });

  test("entityNameOf gives Postgres its type and subtype", () => {
    assert.deepEqual(entityNameOf(Postgres), { type: "database", subtype: "postgres" });
  });

  test("a block class has no entity name", () => {
    new Health();

    assert.equal(entityNameOf(Health), undefined);
  });

  test("a base class records its own fields", () => {
    new BaseResource();

    assert.deepEqual(fieldsOf(BaseResource), [
      { property: "name", kind: "attribute", type: String, optional: false },
      { property: "retries", kind: "attribute", type: Int, optional: false },
    ]);
  });

  test("a subclass inherits its base's fields, the base's first", () => {
    new ChildResource();

    assert.deepEqual(fieldsOf(ChildResource), [
      { property: "name", kind: "attribute", type: String, optional: false },
      { property: "retries", kind: "attribute", type: Int, optional: false },
      { property: "enabled", kind: "attribute", type: Boolean, optional: false },
    ]);
  });

  test("a subclass of a subclass inherits from the whole chain", () => {
    new GrandchildResource();

    assert.deepEqual(fieldsOf(GrandchildResource), [
      { property: "name", kind: "attribute", type: String, optional: false },
      { property: "retries", kind: "attribute", type: Int, optional: false },
      { property: "enabled", kind: "attribute", type: Boolean, optional: false },
      { property: "zone", kind: "attribute", type: String, optional: false },
    ]);
  });

  test("a subclass's own declaration replaces the inherited one, in the base's position", () => {
    new OverridingResource();

    assert.deepEqual(fieldsOf(OverridingResource), [
      { property: "name", kind: "computed", type: String },
      { property: "retries", kind: "attribute", type: Int, optional: false },
      { property: "enabled", kind: "attribute", type: Boolean, optional: false },
    ]);
  });

  test("a subclass's fields do not reach its base class", () => {
    new ChildResource();
    new BaseResource();

    assert.deepEqual(fieldsOf(BaseResource), [
      { property: "name", kind: "attribute", type: String, optional: false },
      { property: "retries", kind: "attribute", type: Int, optional: false },
    ]);
  });

  test("a subclass's override does not change its base class", () => {
    new OverridingResource();
    new BaseResource();

    assert.deepEqual(fieldsOf(BaseResource), [
      { property: "name", kind: "attribute", type: String, optional: false },
      { property: "retries", kind: "attribute", type: Int, optional: false },
    ]);
  });
});
