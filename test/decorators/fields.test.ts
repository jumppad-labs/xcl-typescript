/**
 * One suite, compiled twice: tsconfig.decorators-standard.json and
 * tsconfig.decorators-legacy.json each build it, and the same hand-written
 * expected tables must hold against both outputs. Each test constructs a class
 * before reading its fields, as registration does: a standard decorator fills
 * the table only when an instance is built.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Any, entityNameOf, fieldsOf, Int, isClassThunk, isListSpec, isMapSpec, type FieldSpec, type TypeSpec } from "../../src/decorators.js";
import {
  App,
  BaseResource,
  ChildResource,
  ConstructedTwice,
  DeclaredLater,
  Endpoint,
  ForwardReference,
  GrandchildResource,
  Health,
  Listener,
  ObjectDeclaredLater,
  ObjectHolder,
  OptionalFlags,
  OverridingResource,
  Postgres,
  Route,
  TypeSpecs,
  Volume,
} from "./entities.js";

const compileMode = import.meta.url.includes("decorators-legacy") ? "legacy" : "standard";

/** A type with each class thunk, within lists and maps too, replaced by the class it returns. */
function typeResolved(spec: TypeSpec): unknown {
  if (isListSpec(spec)) {
    return [typeResolved(spec[0])];
  }
  if (isMapSpec(spec)) {
    return { map: typeResolved(spec.map) };
  }
  return isClassThunk(spec) ? spec() : spec;
}

/** The fields with each block thunk and class thunk replaced by the class it returns, so tables compare by value. */
function withBlocksResolved(fields: FieldSpec[]): object[] {
  return fields.map((field) => {
    if (field.block !== undefined) {
      return { ...field, block: field.block() };
    }
    if (field.type !== undefined) {
      return { ...field, type: typeResolved(field.type) };
    }
    return field;
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

  test("Endpoint, an object value's class, records its fields", () => {
    new Endpoint();

    assert.deepEqual(fieldsOf(Endpoint), [
      { property: "port", kind: "attribute", type: Int, optional: false },
      { property: "tls", kind: "attribute", type: Boolean, optional: false },
      { property: "path", kind: "attribute", type: String, optional: true },
    ]);
  });

  test("Route, an object value's class holding an object value, records the class thunk", () => {
    new Route();

    assert.deepEqual(withBlocksResolved(fieldsOf(Route)), [
      { property: "host", kind: "attribute", type: String, optional: false },
      { property: "endpoint", kind: "attribute", type: Endpoint, optional: false },
    ]);
  });

  test("every class-valued type a field can have is recorded as written", () => {
    new ObjectHolder();

    assert.deepEqual(withBlocksResolved(fieldsOf(ObjectHolder)), [
      { property: "defaultEndpoint", kind: "attribute", type: Endpoint, optional: false },
      { property: "endpoints", kind: "attribute", type: [Endpoint], optional: false },
      { property: "routes", kind: "attribute", type: { map: Endpoint }, optional: false },
      { property: "route", kind: "attribute", type: Route, optional: true },
      { property: "assigned", kind: "computed", type: Endpoint },
      { property: "later", kind: "attribute", type: ObjectDeclaredLater, optional: true },
    ]);
  });

  test("a class thunk is recorded as the function itself, not the class it returns", () => {
    new ObjectHolder();

    const type = fieldNamed(fieldsOf(ObjectHolder), "defaultEndpoint").type;
    assert.ok(isClassThunk(type));
    assert.notEqual(type, Endpoint);
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
