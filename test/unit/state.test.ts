import assert from "node:assert/strict";
import { test } from "node:test";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { createConfigWith, type StateStore } from "../../src/config.js";
import { InvalidArgumentError } from "../../src/errors.js";
import { Client } from "../../src/internal/client.js";
import {
  CompleteRequestSchema,
  CompleteResponseSchema,
  CreateConfigRequestSchema,
  CreateConfigResponseSchema,
  PollResponseSchema,
  StartOperationResponseSchema,
  StateResultSchema,
  StateTask_Kind,
  StateTaskSchema,
} from "../../src/internal/core/xcl/core/v1/core_pb.js";
import { aes256gcm, hmacSha256, omit, redact } from "../../src/mask.js";
import { FakeTransport, ok } from "../helpers/fake-transport.js";

const encoder = new TextEncoder();

function stateTask(taskId: bigint, kind: StateTask_Kind, entities: Uint8Array[] = []): ReturnType<typeof ok> {
  return ok(PollResponseSchema, { task: { case: "state", value: create(StateTaskSchema, { taskId, operationId: 1n, kind, entities }) } });
}

function finished(): ReturnType<typeof ok> {
  return ok(PollResponseSchema, { task: { case: "finished", value: { operationId: 1n } } });
}

function engine(): FakeTransport {
  return new FakeTransport()
    .always("CreateConfig", () => ok(CreateConfigResponseSchema, { handle: 7n }))
    .always("StartApply", () => ok(StartOperationResponseSchema, { operationId: 1n }))
    .always("Complete", () => ok(CompleteResponseSchema));
}

function stateAnswer(transport: FakeTransport, index = 0): ReturnType<typeof fromBinary<typeof StateResultSchema>> {
  const answer = fromBinary(CompleteRequestSchema, transport.callsOf("Complete")[index]?.request as Uint8Array);
  assert.equal(answer.result.case, "state");
  return answer.result.value as ReturnType<typeof fromBinary<typeof StateResultSchema>>;
}

function store(overrides: Partial<StateStore> = {}): StateStore {
  return {
    load: () => [],
    save: () => {},
    exists: () => false,
    clear: () => {},
    ...overrides,
  };
}

function createRequest(transport: FakeTransport): ReturnType<typeof fromBinary<typeof CreateConfigRequestSchema>> {
  return fromBinary(CreateConfigRequestSchema, transport.callsOf("CreateConfig")[0]?.request as Uint8Array);
}

test("a load task returns the store's records", async () => {
  const transport = engine().queue("Poll", () => stateTask(1n, StateTask_Kind.LOAD), finished);
  const config = await createConfigWith(new Client(transport), { stateStore: store({ load: () => [encoder.encode('{"a":1}')] }) });

  await config.apply("/x");

  assert.deepEqual(stateAnswer(transport).entities, [encoder.encode('{"a":1}')]);
});

test("a save task hands the store each record", async () => {
  let saved: Uint8Array[] = [];
  const transport = engine().queue("Poll", () => stateTask(1n, StateTask_Kind.SAVE, [encoder.encode("one"), encoder.encode("two")]), finished);
  const config = await createConfigWith(new Client(transport), {
    stateStore: store({
      save: (records) => {
        saved = records;
      },
    }),
  });

  await config.apply("/x");

  assert.deepEqual(saved, [encoder.encode("one"), encoder.encode("two")]);
});

test("an exists task answers whether the store holds state", async () => {
  const transport = engine().queue("Poll", () => stateTask(1n, StateTask_Kind.EXISTS), finished);
  const config = await createConfigWith(new Client(transport), { stateStore: store({ exists: () => true }) });

  await config.apply("/x");

  assert.equal(stateAnswer(transport).exists, true);
});

test("a clear task clears the store", async () => {
  let cleared = false;
  const transport = engine().queue("Poll", () => stateTask(1n, StateTask_Kind.CLEAR), finished);
  const config = await createConfigWith(new Client(transport), {
    stateStore: store({
      clear: () => {
        cleared = true;
      },
    }),
  });

  await config.apply("/x");

  assert.equal(cleared, true);
});

test("asynchronous store methods are awaited", async () => {
  const transport = engine().queue("Poll", () => stateTask(1n, StateTask_Kind.LOAD), finished);
  const config = await createConfigWith(new Client(transport), {
    stateStore: store({
      load: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [encoder.encode("later")];
      },
    }),
  });

  await config.apply("/x");

  assert.deepEqual(stateAnswer(transport).entities, [encoder.encode("later")]);
});

test("a store's exception becomes the task's error with its message", async () => {
  const transport = engine().queue("Poll", () => stateTask(1n, StateTask_Kind.SAVE, [encoder.encode("x")]), finished);
  const config = await createConfigWith(new Client(transport), {
    stateStore: store({
      save: () => {
        throw new Error("the disk is full");
      },
    }),
  });

  await config.apply("/x");

  const result = stateAnswer(transport);
  assert.equal(result.error?.code, "state_store");
  assert.equal(result.error?.message, "the disk is full");
});

test("a state task with no store becomes the task's error", async () => {
  const transport = engine().queue("Poll", () => stateTask(1n, StateTask_Kind.LOAD), finished);
  const config = await createConfigWith(new Client(transport), {});

  await config.apply("/x");

  assert.match(stateAnswer(transport).error?.message ?? "", /no state store/);
});

test("a store is declared as held by the host", async () => {
  const transport = engine();

  await createConfigWith(new Client(transport), { stateStore: store() });

  assert.equal(createRequest(transport).stateStore?.kind.case, "host");
});

test("a state path and a state store together are refused", async () => {
  const transport = engine();

  await assert.rejects(createConfigWith(new Client(transport), { statePath: "/x", stateStore: store() }), InvalidArgumentError);
  assert.equal(transport.callsOf("CreateConfig").length, 0);
});

test("a state mask reaches the engine", async () => {
  const transport = engine();
  const key = new Uint8Array(32).fill(7);

  await createConfigWith(new Client(transport), { statePath: "/x", stateMask: aes256gcm(key) });

  const mask = createRequest(transport).stateMask;
  assert.equal(mask?.kind.case, "aes256gcmKey");
  assert.deepEqual(mask?.kind.value, key);
});

test("an event mask reaches the engine", async () => {
  const transport = engine();

  await createConfigWith(new Client(transport), { eventMask: omit() });

  assert.equal(createRequest(transport).eventMask?.kind.case, "omit");
});

test("noEventMask reaches the engine", async () => {
  const transport = engine();

  await createConfigWith(new Client(transport), { noEventMask: true });

  assert.equal(createRequest(transport).noEventMask, true);
});

test("aes256gcm names its mask", () => {
  assert.equal(aes256gcm(new Uint8Array(32)).name, "aes256gcm");
});

test("aes256gcm refuses a key that is not 32 bytes", () => {
  assert.throws(() => aes256gcm(new Uint8Array(16)), RangeError);
});

test("hmacSha256 refuses an empty key", () => {
  assert.throws(() => hmacSha256(new Uint8Array()), RangeError);
});

test("hmacSha256 carries its key", () => {
  assert.equal(hmacSha256(new Uint8Array([1])).message.kind?.case, "hmacSha256Key");
});

test("redact is the redact mask", () => {
  assert.equal(redact().message.kind?.case, "redact");
});

test("the encoded answer is well formed", () => {
  const bytes = toBinary(StateResultSchema, create(StateResultSchema, { exists: true }));

  assert.equal(fromBinary(StateResultSchema, bytes).exists, true);
});
