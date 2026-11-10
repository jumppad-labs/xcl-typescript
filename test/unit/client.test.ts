import assert from "node:assert/strict";
import { test } from "node:test";

import { fromBinary } from "@bufbuild/protobuf";

import { EngineVersionError, InternalBindingError, NotFoundError, XclError } from "../../src/errors.js";
import { Client } from "../../src/internal/client.js";
import { EntityResponseSchema, FindRequestSchema } from "../../src/internal/core/xcl/core/v1/core_pb.js";
import { ENGINE_VERSION } from "../../src/version.js";
import { failed, FakeTransport, ok } from "../helpers/fake-transport.js";

test("a call encodes its request and decodes its response", async () => {
  const transport = new FakeTransport().always("Find", () => ok(EntityResponseSchema, { entity: new Uint8Array([1, 2]) }));
  const client = new Client(transport);

  const response = await client.call(5n, "find", { address: "app.web" });

  assert.deepEqual(response.entity, new Uint8Array([1, 2]));
  const [call] = transport.callsOf("Find");
  assert.equal(call?.handle, 5n);
  assert.equal(fromBinary(FindRequestSchema, call?.request as Uint8Array).address, "app.web");
});

test("the wire name of a method comes from the descriptor", async () => {
  const transport = new FakeTransport().always("FindOne", () => ok(EntityResponseSchema));
  const client = new Client(transport);

  await client.call(1n, "findOne", { path: ["app"] });

  assert.equal(transport.callsOf("FindOne").length, 1);
});

test("an engine error frame throws its error class", async () => {
  const transport = new FakeTransport().always("Find", () => failed("not_found", "no entity at app.web"));
  const client = new Client(transport);

  await assert.rejects(client.call(1n, "find", { address: "app.web" }), (error: unknown) => {
    assert.ok(error instanceof NotFoundError);
    assert.ok(error instanceof XclError);
    assert.equal(error.message, "no entity at app.web");
    return true;
  });
});

test("a binding fault throws the binding error", async () => {
  const transport = new FakeTransport().always("Find", () => ({ status: -3, payload: new Uint8Array() }));
  const client = new Client(transport);

  await assert.rejects(client.call(1n, "find", { address: "app.web" }), (error: unknown) => {
    assert.ok(error instanceof InternalBindingError);
    assert.equal(error.method, "Find");
    assert.equal(error.status, -3);
    return true;
  });
});

test("a release answered with a fault throws the binding error", async () => {
  const transport = new FakeTransport();
  transport.releaseStatus = -3;
  const client = new Client(transport);

  await assert.rejects(client.release(9n), InternalBindingError);
});

test("the version is checked once however many calls follow", async () => {
  const transport = new FakeTransport().always("Find", () => ok(EntityResponseSchema));
  const client = new Client(transport);

  await Promise.all([client.call(1n, "find", { address: "a" }), client.call(1n, "find", { address: "b" })]);
  await client.call(1n, "find", { address: "c" });

  assert.equal(transport.callsOf("GetVersion").length, 1);
});

test("an engine of the package's version is accepted with a leading v ignored", async () => {
  const transport = new FakeTransport(ENGINE_VERSION.slice(1));
  const client = new Client(transport);

  assert.equal(await client.engineVersion(), ENGINE_VERSION.slice(1));
});

test("an engine of a different version is refused naming both versions", async () => {
  const transport = new FakeTransport("v9.9.9");
  const client = new Client(transport);

  await assert.rejects(client.engineVersion(), (error: unknown) => {
    assert.ok(error instanceof EngineVersionError);
    assert.equal(error.expected, ENGINE_VERSION);
    assert.equal(error.engine, "v9.9.9");
    assert.match(error.message, /v9\.9\.9/);
    assert.ok(error.message.includes(ENGINE_VERSION));
    return true;
  });
});

test("an engine of a different version is stopped", async () => {
  const transport = new FakeTransport("v9.9.9");
  const client = new Client(transport);

  await assert.rejects(client.engineVersion(), EngineVersionError);

  assert.equal(transport.closed, 1);
});

test("an engine of a different version never receives the call", async () => {
  const transport = new FakeTransport("v9.9.9").always("Find", () => ok(EntityResponseSchema));
  const client = new Client(transport);

  await assert.rejects(client.call(1n, "find", { address: "a" }), EngineVersionError);

  assert.equal(transport.callsOf("Find").length, 0);
});

test("an engine of a different ABI version is refused and stopped", async () => {
  const transport = new FakeTransport(ENGINE_VERSION, 2);
  const client = new Client(transport);

  await assert.rejects(client.engineVersion(), EngineVersionError);

  assert.equal(transport.closed, 1);
});

test("a failed version check is repeated on the next use", async () => {
  const transport = new FakeTransport("v9.9.9");
  const client = new Client(transport);

  await assert.rejects(client.engineVersion(), EngineVersionError);
  await assert.rejects(client.engineVersion(), EngineVersionError);

  assert.equal(transport.callsOf("GetVersion").length, 2);
});
