import assert from "node:assert/strict";
import { test } from "node:test";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { createConfigWith, type Config } from "../../src/config.js";
import { Func, Int } from "../../src/decorators.js";
import { SchemaError } from "../../src/errors.js";
import { Client } from "../../src/internal/client.js";
import {
  CompleteRequestSchema,
  CompleteResponseSchema,
  CreateConfigResponseSchema,
  FunctionTaskSchema,
  PollResponseSchema,
  StartOperationResponseSchema,
} from "../../src/internal/core/xcl/core/v1/core_pb.js";
import { LocalRegistry } from "../../src/registry.js";
import { Sensitive } from "../../src/sensitive.js";
import { failed, FakeTransport, ok } from "../helpers/fake-transport.js";

const encoder = new TextEncoder();

function functionTask(taskId: bigint, name: string, args: unknown[]): ReturnType<typeof ok> {
  return ok(PollResponseSchema, {
    task: { case: "function", value: create(FunctionTaskSchema, { taskId, operationId: 1n, name, args: encoder.encode(JSON.stringify(args)) }) },
  });
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

async function open(transport: FakeTransport, registry: LocalRegistry): Promise<Config> {
  return createConfigWith(new Client(transport), { registries: [registry] });
}

function answers(transport: FakeTransport): ReturnType<typeof decodeAnswer>[] {
  return transport.callsOf("Complete").map(decodeAnswer);
}

function decodeAnswer(call: { request: Uint8Array }) {
  return fromBinary(CompleteRequestSchema, call.request);
}

class Functions {
  @Func([String], String)
  slugify(title: string): string {
    return title.toLowerCase().replaceAll(" ", "-");
  }

  @Func([Int, Int], Int)
  async add(a: number, b: number): Promise<number> {
    return a + b;
  }

  @Func([String], String)
  broken(): string {
    throw new Error("the function failed");
  }

  @Func([String], String)
  secret(): Sensitive<string> {
    return new Sensitive("hunter2");
  }

  notOffered(): string {
    return "x";
  }
}

function registered(): LocalRegistry {
  const registry = new LocalRegistry();
  registry.registerFunctions(new Functions());
  return registry;
}

function resultOf(answer: ReturnType<typeof decodeAnswer>): unknown {
  assert.equal(answer.result.case, "function");
  return JSON.parse(new TextDecoder().decode((answer.result.value as { result: Uint8Array }).result));
}

test("only decorated methods are offered", () => {
  const names = registered().functions.map((declared) => declared.name);

  assert.deepEqual(names.sort(), ["add", "broken", "secret", "slugify"]);
});

test("the proto carries each function with its signature", () => {
  const proto = registered().toProto() as { kind: { value: { functions: { name: string; signature: Uint8Array }[] } } };

  const add = proto.kind.value.functions.find((declared) => declared.name === "add");

  assert.deepEqual(JSON.parse(new TextDecoder().decode(add?.signature)), {
    params: [
      { name: "arg0", type: "number" },
      { name: "arg1", type: "number" },
    ],
    return: "number",
  });
});

test("a type with no configuration form is refused at registration", () => {
  class Bad {
    @Func([Symbol as unknown as typeof String], String)
    bad(): string {
      return "";
    }
  }
  const registry = new LocalRegistry();

  assert.throws(() => registry.registerFunctions(new Bad()), SchemaError);
});

test("two functions of one name are both declared, for the engine to refuse", () => {
  class One {
    @Func([], String, { name: "same" })
    first(): string {
      return "1";
    }
  }
  class Two {
    @Func([], String, { name: "same" })
    second(): string {
      return "2";
    }
  }
  const registry = new LocalRegistry();

  registry.registerFunctions(new One());
  registry.registerFunctions(new Two());

  assert.deepEqual(
    registry.functions.map((declared) => declared.name),
    ["same", "same"],
  );
});

test("a function task is answered with the function's result", async () => {
  const transport = engine().queue("Poll", () => functionTask(11n, "slugify", ["My App"]), finished);
  const config = await open(transport, registered());

  await config.apply("/x");

  const [answer] = answers(transport);
  assert.equal(answer?.taskId, 11n);
  assert.equal(resultOf(answer as ReturnType<typeof decodeAnswer>), "my-app");
});

test("an async function's resolved value is the result", async () => {
  const transport = engine().queue("Poll", () => functionTask(12n, "add", [2, 3]), finished);
  const config = await open(transport, registered());

  await config.apply("/x");

  assert.equal(resultOf(answers(transport)[0] as ReturnType<typeof decodeAnswer>), 5);
});

test("a thrown error becomes the call's error", async () => {
  const transport = engine().queue("Poll", () => functionTask(13n, "broken", ["x"]), finished);
  const config = await open(transport, registered());

  await config.apply("/x");

  const answer = answers(transport)[0] as ReturnType<typeof decodeAnswer>;
  assert.equal(answer.result.case, "function");
  assert.equal((answer.result.value as { error?: { message: string } }).error?.message, "the function failed");
});

test("an unknown function becomes the call's error", async () => {
  const transport = engine().queue("Poll", () => functionTask(14n, "missing", []), finished);
  const config = await open(transport, registered());

  await config.apply("/x");

  const answer = answers(transport)[0] as ReturnType<typeof decodeAnswer>;
  assert.match((answer.result.value as { error?: { message: string } }).error?.message ?? "", /missing/);
});

test("a Sensitive result crosses as its real value", async () => {
  const transport = engine().queue("Poll", () => functionTask(15n, "secret", ["x"]), finished);
  const config = await open(transport, registered());

  await config.apply("/x");

  assert.equal(resultOf(answers(transport)[0] as ReturnType<typeof decodeAnswer>), "hunter2");
});

test("function tasks run concurrently", async () => {
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const order: string[] = [];
  class Concurrent {
    @Func([], String)
    async slow(): Promise<string> {
      await slowGate;
      order.push("slow");
      return "slow";
    }

    @Func([], String)
    quick(): string {
      order.push("quick");
      releaseSlow();
      return "quick";
    }
  }
  const registry = new LocalRegistry();
  registry.registerFunctions(new Concurrent());
  const transport = engine().queue("Poll", () => functionTask(1n, "slow", []), () => functionTask(2n, "quick", []), finished);
  const config = await open(transport, registry);

  await config.apply("/x");

  assert.deepEqual(order, ["quick", "slow"]);
});

test("the operation waits for every function before it settles", async () => {
  let finishedFunction = false;
  class Waited {
    @Func([], String)
    async waited(): Promise<string> {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finishedFunction = true;
      return "done";
    }
  }
  const registry = new LocalRegistry();
  registry.registerFunctions(new Waited());
  const transport = engine().queue("Poll", () => functionTask(1n, "waited", []), finished);
  const config = await open(transport, registry);

  await config.apply("/x");

  assert.equal(finishedFunction, true);
});

test("a late answer the engine no longer waits for is ignored", async () => {
  const transport = engine()
    .queue("Poll", () => functionTask(1n, "slugify", ["x"]), finished)
    .always("Complete", () => failed("invalid_argument", "the task is not waiting"));
  const config = await open(transport, registered());

  await assert.doesNotReject(config.apply("/x"));
});

test("a failed answer rejects the operation", async () => {
  const transport = engine()
    .queue("Poll", () => functionTask(1n, "slugify", ["x"]), finished)
    .always("Complete", () => failed("internal", "the engine failed"));
  const config = await open(transport, registered());

  await assert.rejects(config.apply("/x"), /the engine failed/);
});

test("the encoded request is well formed", () => {
  const bytes = toBinary(CompleteRequestSchema, create(CompleteRequestSchema, { taskId: 1n }));

  assert.equal(fromBinary(CompleteRequestSchema, bytes).taskId, 1n);
});
