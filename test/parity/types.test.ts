/** Each parity fixture's classes in `types.ts` derive exactly its `types.json` documents. */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { LocalRegistry, type EntityClass } from "../../src/index.js";
import { skipReason } from "../helpers/engine.js";
import { parityFixturesDirectory } from "./run.js";
import { FIXTURES } from "./types.js";

function missingFixtures(): string | false {
  const directory = parityFixturesDirectory();
  if (!existsSync(directory)) {
    return skipReason(`the parity fixtures are not at ${directory}; set XCL_SRC to the xcl checkout`);
  }
  return false;
}

const needsFixtures = missingFixtures();

function documents(fixture: string): unknown {
  return JSON.parse(readFileSync(join(parityFixturesDirectory(), fixture, "types.json"), "utf8"));
}

function derived(fixture: string): unknown {
  const local = new LocalRegistry();
  local.register(...(FIXTURES[fixture] as readonly EntityClass[]));
  return local.registrations.map((registration) => registration.schema);
}

test("the basic_types classes derive the fixture's types.json", { skip: needsFixtures }, () => {
  assert.deepEqual(derived("basic_types"), documents("basic_types"));
});

test("the annotations classes derive the fixture's types.json", { skip: needsFixtures }, () => {
  assert.deepEqual(derived("annotations"), documents("annotations"));
});

test("the functions classes derive the fixture's types.json", { skip: needsFixtures }, () => {
  assert.deepEqual(derived("functions"), documents("functions"));
});

test("the variables classes derive the fixture's types.json", { skip: needsFixtures }, () => {
  assert.deepEqual(derived("variables"), documents("variables"));
});

test("the outputs classes derive the fixture's types.json", { skip: needsFixtures }, () => {
  assert.deepEqual(derived("outputs"), documents("outputs"));
});

test("the plugin_entities classes derive the fixture's types.json", { skip: needsFixtures }, () => {
  assert.deepEqual(derived("plugin_entities"), documents("plugin_entities"));
});

test("the invalid classes derive the fixture's types.json", { skip: needsFixtures }, () => {
  assert.deepEqual(derived("invalid"), documents("invalid"));
});

test("the singletons classes derive the fixture's types.json", { skip: needsFixtures }, () => {
  assert.deepEqual(derived("singletons"), documents("singletons"));
});

test("the encode classes derive the fixture's types.json", { skip: needsFixtures }, () => {
  assert.deepEqual(derived("encode"), documents("encode"));
});

test("the unsupported_block classes derive the fixture's types.json", { skip: needsFixtures }, () => {
  assert.deepEqual(derived("unsupported_block"), documents("unsupported_block"));
});
