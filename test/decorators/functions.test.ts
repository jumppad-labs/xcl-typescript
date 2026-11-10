import assert from "node:assert/strict";
import { test } from "node:test";

import { LocalRegistry } from "../../src/registry.js";
import { Functions } from "./entities.js";

test("a decorated method is offered under its own name", () => {
  const registry = new LocalRegistry();

  registry.registerFunctions(new Functions());

  const slugify = registry.functions.find((declared) => declared.name === "slugify");
  assert.deepEqual(slugify?.signature, { params: [{ name: "arg0", type: "string" }], return: "string" });
});

test("the name option overrides the method's name", () => {
  const registry = new LocalRegistry();

  registry.registerFunctions(new Functions());

  assert.deepEqual(registry.functions.map((declared) => declared.name).sort(), ["shout", "slugify"]);
});

test("a registered method is bound to its instance and can be called", async () => {
  const registry = new LocalRegistry();

  registry.registerFunctions(new Functions());

  assert.equal(registry.functions.find((declared) => declared.name === "slugify")?.call("My App"), "my-app");
  assert.equal(await registry.functions.find((declared) => declared.name === "shout")?.call("hi"), "HI");
});
