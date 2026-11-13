import assert from "node:assert/strict";
import { test } from "node:test";

import { diffPath, outputKey, roundTrips, toCamel, toSnake } from "../../src/hydrate.js";

test("toSnake writes connectionString as connection_string", () => {
  assert.equal(toSnake("connectionString"), "connection_string");
});

test("toSnake writes dockerId as docker_id", () => {
  assert.equal(toSnake("dockerId"), "docker_id");
});

test("toSnake leaves a single lower-case word alone", () => {
  assert.equal(toSnake("image"), "image");
});

test("toSnake leaves digits alone", () => {
  assert.equal(toSnake("port_8080"), "port_8080");
});

test("toSnake converts the letter after digits", () => {
  assert.equal(toSnake("http2Port"), "http2_port");
});

test("toCamel writes connection_string as connectionString", () => {
  assert.equal(toCamel("connection_string"), "connectionString");
});

test("toCamel writes docker_id as dockerId", () => {
  assert.equal(toCamel("docker_id"), "dockerId");
});

test("toCamel leaves a single lower-case word alone", () => {
  assert.equal(toCamel("image"), "image");
});

test("toCamel leaves an underscore before digits alone", () => {
  assert.equal(toCamel("port_8080"), "port_8080");
});

test("toCamel converts the letter after digits", () => {
  assert.equal(toCamel("http2_port"), "http2Port");
});

test("connectionString round trips", () => {
  assert.equal(roundTrips("connectionString"), true);
});

test("dockerId round trips", () => {
  assert.equal(roundTrips("dockerId"), true);
});

test("a single lower-case word round trips", () => {
  assert.equal(roundTrips("image"), true);
});

test("port_8080 round trips", () => {
  assert.equal(roundTrips("port_8080"), true);
});

test("port8080 round trips", () => {
  assert.equal(roundTrips("port8080"), true);
});

test("http2Port round trips", () => {
  assert.equal(roundTrips("http2Port"), true);
});

test("_private is refused because a leading underscore does not survive", () => {
  assert.equal(roundTrips("_private"), false);
});

test("already_snake is refused because it comes back as alreadySnake", () => {
  assert.equal(roundTrips("already_snake"), false);
});

test("an output's address converts its name", () => {
  assert.equal(outputKey("output.my_value"), "output.myValue");
});

test("a module output's address converts only its last segment", () => {
  assert.equal(outputKey("module.db.output.my_value"), "module.db.output.myValue");
});

test("a module whose name has an underscore keeps it", () => {
  assert.equal(outputKey("module.my_db.output.my_value"), "module.my_db.output.myValue");
});

test("an output address with no dot converts the whole name", () => {
  assert.equal(outputKey("my_value"), "myValue");
});

test("a diff path of one attribute stays a name", () => {
  assert.equal(diffPath("image"), "image");
});

test("a diff path converts an attribute's name", () => {
  assert.equal(diffPath("host_port"), "hostPort");
});

test("a diff path converts the attribute after an index", () => {
  assert.equal(diffPath("ports[0].host_port"), "ports[0].hostPort");
});

test("a diff path converts the attribute before an index", () => {
  assert.equal(diffPath("container_ports[1].host_port"), "containerPorts[1].hostPort");
});

test("a diff path leaves an upper-case map key as written", () => {
  assert.equal(diffPath('env["LOG_LEVEL"]'), 'env["LOG_LEVEL"]');
});

test("a diff path leaves a snake_case map key as written", () => {
  assert.equal(diffPath('env["some_key"]'), 'env["some_key"]');
});

test("a diff path converts the attribute holding a map key", () => {
  assert.equal(diffPath('extra_env["some_key"]'), 'extraEnv["some_key"]');
});

test("a diff path converts the attribute after a map key", () => {
  assert.equal(diffPath('labels["some_key"].inner_value'), 'labels["some_key"].innerValue');
});

test("a diff path leaves a dot inside a map key as written", () => {
  assert.equal(diffPath('env["some.dotted_key"]'), 'env["some.dotted_key"]');
});

test("a diff path leaves an escaped quote inside a map key as written", () => {
  assert.equal(diffPath('env["some\\"quoted_key"]'), 'env["some\\"quoted_key"]');
});
