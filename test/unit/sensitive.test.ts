import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";

import { isSensitive, Sensitive } from "../../src/sensitive.js";

test("String prints a value as (sensitive)", () => {
  assert.equal(String(new Sensitive("s3cret")), "(sensitive)");
});

test("a template literal prints a value as (sensitive)", () => {
  assert.equal(`password=${new Sensitive("s3cret")}`, "password=(sensitive)");
});

test("JSON.stringify prints a value as (sensitive)", () => {
  assert.equal(JSON.stringify(new Sensitive("s3cret")), '"(sensitive)"');
});

test("JSON.stringify prints a value inside an object as (sensitive)", () => {
  assert.equal(JSON.stringify({ user: "admin", password: new Sensitive("s3cret") }), '{"user":"admin","password":"(sensitive)"}');
});

test("util.inspect prints a value as (sensitive)", () => {
  assert.equal(inspect(new Sensitive("s3cret")), "(sensitive)");
});

test("util.inspect prints a value inside an object as (sensitive)", () => {
  assert.equal(inspect({ password: new Sensitive("s3cret") }), "{ password: (sensitive) }");
});

test("String prints a value that is not a string as (sensitive)", () => {
  assert.equal(String(new Sensitive({ token: "s3cret" })), "(sensitive)");
});

test("JSON.stringify prints a value that is not a string as (sensitive)", () => {
  assert.equal(JSON.stringify(new Sensitive({ token: "s3cret" })), '"(sensitive)"');
});

test("util.inspect prints a value that is not a string as (sensitive)", () => {
  assert.equal(inspect(new Sensitive({ token: "s3cret" })), "(sensitive)");
});

test("String prints a redacted value as (sensitive)", () => {
  assert.equal(String(Sensitive.redacted()), "(sensitive)");
});

test("a template literal prints a redacted value as (sensitive)", () => {
  assert.equal(`password=${Sensitive.redacted()}`, "password=(sensitive)");
});

test("JSON.stringify prints a redacted value as (sensitive)", () => {
  assert.equal(JSON.stringify(Sensitive.redacted()), '"(sensitive)"');
});

test("JSON.stringify prints a redacted value inside an object as (sensitive)", () => {
  assert.equal(JSON.stringify({ password: Sensitive.redacted() }), '{"password":"(sensitive)"}');
});

test("util.inspect prints a redacted value as (sensitive)", () => {
  assert.equal(inspect(Sensitive.redacted()), "(sensitive)");
});

test("reveal returns the value held", () => {
  assert.equal(new Sensitive("x").reveal(), "x");
});

test("reveal returns an object held, by identity", () => {
  const credentials = { token: "s3cret" };

  assert.equal(new Sensitive(credentials).reveal(), credentials);
});

test("reveal returns an empty string held, rather than treating it as masked", () => {
  assert.equal(new Sensitive("").reveal(), "");
});

test("reveal returns undefined for a redacted value", () => {
  assert.equal(Sensitive.redacted().reveal(), undefined);
});

test("isRedacted is false for a value that holds one", () => {
  assert.equal(new Sensitive("x").isRedacted, false);
});

test("isRedacted is false for a value holding undefined", () => {
  assert.equal(new Sensitive(undefined).isRedacted, false);
});

test("isRedacted is true for a redacted value", () => {
  assert.equal(Sensitive.redacted().isRedacted, true);
});

test("isSensitive is true for a value built with new", () => {
  assert.equal(isSensitive(new Sensitive("x")), true);
});

test("isSensitive is true for a redacted value", () => {
  assert.equal(isSensitive(Sensitive.redacted()), true);
});

test("isSensitive is false for a plain string", () => {
  assert.equal(isSensitive("x"), false);
});

test("isSensitive is false for undefined", () => {
  assert.equal(isSensitive(undefined), false);
});

test("Sensitive called without new returns a decorator function", () => {
  assert.equal(typeof Sensitive(String), "function");
});

test("Sensitive called without new does not return a Sensitive value", () => {
  assert.equal(isSensitive(Sensitive(String)), false);
});

test("Sensitive called without new and with options returns a decorator function", () => {
  assert.equal(typeof Sensitive(String, { optional: true }), "function");
});
