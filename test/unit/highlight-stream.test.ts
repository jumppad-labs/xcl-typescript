import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { plain, terminal } from "../../src/highlight/formatters.js";
import { forStream } from "../../src/highlight/stream.js";

let previous: string | undefined;

beforeEach(() => {
  previous = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
});

afterEach(() => {
  if (previous === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = previous;
  }
});

test("a terminal stream gets terminal colour", () => {
  assert.equal(forStream({ isTTY: true }), terminal);
});

test("a terminal stream with NO_COLOR set gets plain text", () => {
  process.env.NO_COLOR = "1";
  assert.equal(forStream({ isTTY: true }), plain);
});

test("a terminal stream with an empty NO_COLOR gets terminal colour", () => {
  process.env.NO_COLOR = "";
  assert.equal(forStream({ isTTY: true }), terminal);
});

test("a non-terminal stream gets plain text", () => {
  assert.equal(forStream({ isTTY: false }), plain);
});

test("a stream that does not say it is a terminal gets plain text", () => {
  assert.equal(forStream({}), plain);
});
