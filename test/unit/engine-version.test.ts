import assert from "node:assert/strict";
import { test } from "node:test";

import { engineVersionWith } from "../../src/engine-version.js";
import { EngineNotFoundError, EngineVersionError } from "../../src/errors.js";
import * as xcl from "../../src/index.js";
import { Client } from "../../src/internal/client.js";
import { ENGINE_VERSION } from "../../src/version.js";
import { FakeTransport } from "../helpers/fake-transport.js";

test("the package exports engineVersion", () => {
  assert.equal(typeof xcl.engineVersion, "function");
});

test("engineVersion reports the version the engine gives", async () => {
  const transport = new FakeTransport(ENGINE_VERSION);
  const client = new Client(transport);

  const version = await engineVersionWith(client);

  assert.equal(version, ENGINE_VERSION);
});

test("engineVersion reports the engine's version as it gives it, without a leading v", async () => {
  const transport = new FakeTransport(ENGINE_VERSION.slice(1));
  const client = new Client(transport);

  const version = await engineVersionWith(client);

  assert.equal(version, ENGINE_VERSION.slice(1));
});

test("engineVersion asks the engine once however often it is called", async () => {
  const transport = new FakeTransport(ENGINE_VERSION);
  const client = new Client(transport);

  await engineVersionWith(client);
  await engineVersionWith(client);

  assert.equal(transport.callsOf("GetVersion").length, 1);
});

test("engineVersion rejects an engine of a different version with EngineVersionError", async () => {
  const transport = new FakeTransport("v9.9.9");
  const client = new Client(transport);

  await assert.rejects(engineVersionWith(client), (error: unknown) => {
    assert.ok(error instanceof EngineVersionError);
    assert.equal(error.engine, "v9.9.9");
    assert.equal(error.expected, ENGINE_VERSION);
    return true;
  });
});

test("engineVersion rejects with EngineNotFoundError when the engine cannot be found", async () => {
  const transport = new FakeTransport().always("GetVersion", () => {
    throw new EngineNotFoundError("the xcl engine was not found", "@jumppad-labs/xcl-lang-linux-x64-gnu");
  });
  const client = new Client(transport);

  await assert.rejects(engineVersionWith(client), (error: unknown) => {
    assert.ok(error instanceof EngineNotFoundError);
    assert.equal(error.packageName, "@jumppad-labs/xcl-lang-linux-x64-gnu");
    return true;
  });
});
