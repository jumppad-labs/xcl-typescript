import assert from "node:assert/strict";
import { test } from "node:test";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { CoreService } from "../../src/internal/core/xcl/core/v1/core_pb.js";
import { RequestSchema } from "../../src/internal/core/xcl/core/v1/transport_pb.js";

test("a frame request survives encoding and decoding", () => {
  const request = create(RequestSchema, {
    id: 7n,
    handle: 9n,
    method: "GetVersion",
    payload: new Uint8Array([1, 2, 3]),
  });

  const decoded = fromBinary(RequestSchema, toBinary(RequestSchema, request));

  assert.equal(decoded.id, 7n);
  assert.equal(decoded.handle, 9n);
  assert.equal(decoded.method, "GetVersion");
  assert.deepEqual(decoded.payload, new Uint8Array([1, 2, 3]));
});

test("the generated service describes the methods the SDK calls", () => {
  assert.ok(CoreService.method.getVersion);
  assert.equal(CoreService.method.getVersion.name, "GetVersion");
  assert.ok(CoreService.method.startApply);
  assert.ok(CoreService.method.poll);
  assert.ok(CoreService.method.complete);
});
