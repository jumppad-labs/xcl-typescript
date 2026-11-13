/**
 * Cancellation against a scripted engine: what an `AbortSignal` does to the
 * poll loop. Each test holds `Poll` open with a promise it resolves by hand, so
 * it decides exactly what the engine has answered when the abort happens.
 */

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";

import { create, fromBinary } from "@bufbuild/protobuf";

import { configWith, type Config } from "../../src/config.js";
import { Func } from "../../src/decorators.js";
import { CancelledError, ConfigError } from "../../src/errors.js";
import { Client } from "../../src/internal/client.js";
import {
  CancelRequestSchema,
  CancelResponseSchema,
  CompleteResponseSchema,
  CreateConfigResponseSchema,
  EventSchema,
  FunctionTaskSchema,
  PollResponseSchema,
  StartOperationResponseSchema,
  StateTask_Kind,
  StateTaskSchema,
} from "../../src/internal/core/xcl/core/v1/core_pb.js";
import type { StateStore } from "../../src/internal/poll.js";
import type { CallResult } from "../../src/internal/transport.js";
import { LocalRegistry } from "../../src/registry.js";
import { failed, FakeTransport, ok } from "../helpers/fake-transport.js";

const encoder = new TextEncoder();

/** How long a test waits for something that should happen at once, in milliseconds. */
const PROMPTLY_MS = 2000;

/** A `Poll` answer the test gives by hand, for as long as it wants the poll to stay open. */
interface HeldPoll {
  answer: () => Promise<CallResult>;
  release: (result: CallResult) => void;
}

function heldPoll(): HeldPoll {
  let release!: (result: CallResult) => void;
  const answer = new Promise<CallResult>((resolve) => {
    release = resolve;
  });
  return { answer: () => answer, release };
}

function finished(): CallResult {
  return ok(PollResponseSchema, { task: { case: "finished", value: { operationId: 1n } } });
}

function finishedCancelled(): CallResult {
  return ok(PollResponseSchema, { task: { case: "finished", value: { operationId: 1n, error: { code: "cancelled", message: "the operation was cancelled" } } } });
}

function finishedFailed(): CallResult {
  return ok(PollResponseSchema, { task: { case: "finished", value: { operationId: 1n, error: { code: "config", message: "the configuration is wrong" } } } });
}

function eventTask(): CallResult {
  return ok(PollResponseSchema, { task: { case: "event", value: create(EventSchema, { source: "core", operation: "apply", phase: "start" }) } });
}

function functionTask(name: string): CallResult {
  return ok(PollResponseSchema, { task: { case: "function", value: create(FunctionTaskSchema, { taskId: 1n, operationId: 1n, name, args: encoder.encode("[]") }) } });
}

function saveTask(): CallResult {
  return ok(PollResponseSchema, { task: { case: "state", value: create(StateTaskSchema, { taskId: 1n, operationId: 1n, kind: StateTask_Kind.SAVE }) } });
}

function engine(): FakeTransport {
  return new FakeTransport()
    .always("CreateConfig", () => ok(CreateConfigResponseSchema, { handle: 7n }))
    .always("StartValidate", () => ok(StartOperationResponseSchema, { operationId: 1n }))
    .always("StartApply", () => ok(StartOperationResponseSchema, { operationId: 1n }))
    .always("StartDiff", () => ok(StartOperationResponseSchema, { operationId: 1n }))
    .always("StartLoad", () => ok(StartOperationResponseSchema, { operationId: 1n }))
    .always("StartDestroy", () => ok(StartOperationResponseSchema, { operationId: 1n }))
    .always("Cancel", () => ok(CancelResponseSchema))
    .always("Complete", () => ok(CompleteResponseSchema));
}

function open(transport: FakeTransport): Promise<Config> {
  return configWith(new Client(transport), {}).setup();
}

/** Waits for `condition`, checking between turns of the event loop. */
async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + PROMPTLY_MS;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting until ${what}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Lets everything already queued run, for a test showing something did not happen. */
async function settleEventLoop(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** `promise`, or a rejection when it has not settled in time: a stuck operation fails its test rather than hanging it. */
async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`the promise did not settle within ${PROMPTLY_MS}ms`));
    }, PROMPTLY_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// -- Cancel is sent at once ---------------------------------------------------

test("aborting sends Cancel while the poll is still held open", async () => {
  const held = heldPoll();
  const transport = engine().queue("Poll", held.answer);
  const config = await open(transport);
  const controller = new AbortController();

  const applying = config.apply("/x", { signal: controller.signal });
  await waitUntil(() => transport.callsOf("Poll").length === 1, "the poll is open");
  controller.abort();
  await waitUntil(() => transport.callsOf("Cancel").length === 1, "Cancel is sent");

  // the poll has not answered: Cancel went out without waiting for it
  assert.equal(transport.callsOf("Poll").length, 1);
  held.release(finishedCancelled());
  await assert.rejects(promptly(applying), CancelledError);
});

test("Cancel names the operation and goes to the configuration's handle", async () => {
  const held = heldPoll();
  const transport = engine().queue("Poll", held.answer);
  const config = await open(transport);
  const controller = new AbortController();

  const applying = config.apply("/x", { signal: controller.signal });
  await waitUntil(() => transport.callsOf("Poll").length === 1, "the poll is open");
  controller.abort();
  await waitUntil(() => transport.callsOf("Cancel").length === 1, "Cancel is sent");
  held.release(finishedCancelled());
  await assert.rejects(promptly(applying), CancelledError);

  const [call] = transport.callsOf("Cancel");
  assert.equal(call?.handle, 7n);
  assert.equal(fromBinary(CancelRequestSchema, call?.request as Uint8Array).operationId, 1n);
});

test("aborting while the operation is starting cancels it as soon as it exists", async () => {
  let answerStart!: (result: CallResult) => void;
  const starting = new Promise<CallResult>((resolve) => {
    answerStart = resolve;
  });
  const held = heldPoll();
  const transport = engine()
    .always("StartApply", () => starting)
    .queue("Poll", held.answer);
  const config = await open(transport);
  const controller = new AbortController();

  const applying = config.apply("/x", { signal: controller.signal });
  await waitUntil(() => transport.callsOf("StartApply").length === 1, "the start is on its way");
  controller.abort();
  assert.equal(transport.callsOf("Cancel").length, 0);
  answerStart(ok(StartOperationResponseSchema, { operationId: 1n }));
  await waitUntil(() => transport.callsOf("Cancel").length === 1, "Cancel is sent");

  held.release(finishedCancelled());
  await assert.rejects(promptly(applying), CancelledError);
});

test("a configuration takes another operation after a cancelled one", async () => {
  const held = heldPoll();
  const transport = engine().queue("Poll", held.answer, finished);
  const config = await open(transport);
  const controller = new AbortController();

  const applying = config.apply("/x", { signal: controller.signal });
  await waitUntil(() => transport.callsOf("Poll").length === 1, "the poll is open");
  controller.abort();
  held.release(finishedCancelled());
  await assert.rejects(promptly(applying), CancelledError);

  await assert.doesNotReject(promptly(config.apply("/x")));
});

// -- the cause of the rejection -----------------------------------------------

test("the cause of the CancelledError is the signal's reason", async () => {
  const held = heldPoll();
  const transport = engine().queue("Poll", held.answer);
  const config = await open(transport);
  const controller = new AbortController();
  const reason = new Error("the user pressed stop");

  const applying = config.apply("/x", { signal: controller.signal });
  await waitUntil(() => transport.callsOf("Poll").length === 1, "the poll is open");
  controller.abort(reason);
  held.release(finishedCancelled());

  await assert.rejects(promptly(applying), (error: unknown) => {
    assert.ok(error instanceof CancelledError);
    assert.equal(error.cause, reason);
    return true;
  });
});

test("the cause of the CancelledError is the default AbortError when no reason is given", async () => {
  const held = heldPoll();
  const transport = engine().queue("Poll", held.answer);
  const config = await open(transport);
  const controller = new AbortController();

  const applying = config.apply("/x", { signal: controller.signal });
  await waitUntil(() => transport.callsOf("Poll").length === 1, "the poll is open");
  controller.abort();
  held.release(finishedCancelled());

  await assert.rejects(promptly(applying), (error: unknown) => {
    assert.ok(error instanceof CancelledError);
    assert.equal(error.cause, controller.signal.reason);
    assert.equal((error.cause as DOMException).name, "AbortError");
    return true;
  });
});

test("a reason that is not an Error is still the cause", async () => {
  const held = heldPoll();
  const transport = engine().queue("Poll", held.answer);
  const config = await open(transport);
  const controller = new AbortController();

  const applying = config.apply("/x", { signal: controller.signal });
  await waitUntil(() => transport.callsOf("Poll").length === 1, "the poll is open");
  controller.abort("stopped by the deploy script");
  held.release(finishedCancelled());

  await assert.rejects(promptly(applying), (error: unknown) => {
    assert.ok(error instanceof CancelledError);
    assert.equal(error.cause, "stopped by the deploy script");
    return true;
  });
});

// -- an already aborted signal ------------------------------------------------

test("an already aborted signal rejects an apply without starting it", async () => {
  const transport = engine();
  const config = await open(transport);

  await assert.rejects(promptly(config.apply("/x", { signal: AbortSignal.abort() })), CancelledError);

  assert.equal(transport.callsOf("StartApply").length, 0);
  assert.equal(transport.callsOf("Poll").length, 0);
  assert.equal(transport.callsOf("Cancel").length, 0);
});

test("an already aborted signal's rejection has its reason as the cause", async () => {
  const transport = engine();
  const config = await open(transport);
  const reason = new Error("stopped before it began");

  await assert.rejects(promptly(config.apply("/x", { signal: AbortSignal.abort(reason) })), (error: unknown) => {
    assert.ok(error instanceof CancelledError);
    assert.equal(error.cause, reason);
    return true;
  });
});

test("an already aborted signal rejects a validate without starting it", async () => {
  const transport = engine();
  const config = await open(transport);

  await assert.rejects(promptly(config.validate("/x", { signal: AbortSignal.abort() })), CancelledError);

  assert.equal(transport.callsOf("StartValidate").length, 0);
});

test("an already aborted signal rejects a diff without starting it", async () => {
  const transport = engine();
  const config = await open(transport);

  await assert.rejects(promptly(config.diff("/x", { signal: AbortSignal.abort() })), CancelledError);

  assert.equal(transport.callsOf("StartDiff").length, 0);
});

test("an already aborted signal rejects a load without starting it", async () => {
  const transport = engine();
  const config = await open(transport);

  await assert.rejects(promptly(config.load({ signal: AbortSignal.abort() })), CancelledError);

  assert.equal(transport.callsOf("StartLoad").length, 0);
});

test("an already aborted signal rejects a destroy without starting it", async () => {
  const transport = engine();
  const config = await open(transport);

  await assert.rejects(promptly(config.destroy({ signal: AbortSignal.abort() })), CancelledError);

  assert.equal(transport.callsOf("StartDestroy").length, 0);
});

// -- every operation takes a signal -------------------------------------------

test("a validate is cancelled by its signal", async () => {
  const held = heldPoll();
  const transport = engine().queue("Poll", held.answer);
  const config = await open(transport);
  const controller = new AbortController();

  const validating = config.validate("/x", { signal: controller.signal });
  await waitUntil(() => transport.callsOf("Poll").length === 1, "the poll is open");
  controller.abort();
  await waitUntil(() => transport.callsOf("Cancel").length === 1, "Cancel is sent");
  held.release(finishedCancelled());

  await assert.rejects(promptly(validating), CancelledError);
});

test("an apply is cancelled by its signal", async () => {
  const held = heldPoll();
  const transport = engine().queue("Poll", held.answer);
  const config = await open(transport);
  const controller = new AbortController();

  const applying = config.apply("/x", { signal: controller.signal });
  await waitUntil(() => transport.callsOf("Poll").length === 1, "the poll is open");
  controller.abort();
  await waitUntil(() => transport.callsOf("Cancel").length === 1, "Cancel is sent");
  held.release(finishedCancelled());

  await assert.rejects(promptly(applying), CancelledError);
});

test("a diff is cancelled by its signal", async () => {
  const held = heldPoll();
  const transport = engine().queue("Poll", held.answer);
  const config = await open(transport);
  const controller = new AbortController();

  const diffing = config.diff("/x", { signal: controller.signal });
  await waitUntil(() => transport.callsOf("Poll").length === 1, "the poll is open");
  controller.abort();
  await waitUntil(() => transport.callsOf("Cancel").length === 1, "Cancel is sent");
  held.release(finishedCancelled());

  await assert.rejects(promptly(diffing), CancelledError);
});

test("a load is cancelled by its signal", async () => {
  const held = heldPoll();
  const transport = engine().queue("Poll", held.answer);
  const config = await open(transport);
  const controller = new AbortController();

  const loading = config.load({ signal: controller.signal });
  await waitUntil(() => transport.callsOf("Poll").length === 1, "the poll is open");
  controller.abort();
  await waitUntil(() => transport.callsOf("Cancel").length === 1, "Cancel is sent");
  held.release(finishedCancelled());

  await assert.rejects(promptly(loading), CancelledError);
});

test("a destroy is cancelled by its signal", async () => {
  const held = heldPoll();
  const transport = engine().queue("Poll", held.answer);
  const config = await open(transport);
  const controller = new AbortController();

  const destroying = config.destroy({ signal: controller.signal });
  await waitUntil(() => transport.callsOf("Poll").length === 1, "the poll is open");
  controller.abort();
  await waitUntil(() => transport.callsOf("Cancel").length === 1, "Cancel is sent");
  held.release(finishedCancelled());

  await assert.rejects(promptly(destroying), CancelledError);
});

// -- nothing of the program's holds up the rejection --------------------------

test("after a cancel the rejection does not wait for a stuck event handler", async () => {
  let handlerCalled = false;
  const held = heldPoll();
  const transport = engine().queue("Poll", eventTask, held.answer);
  const config = await configWith(new Client(transport), {
    onEvent: () => {
      handlerCalled = true;
      return new Promise<void>(() => {});
    },
  }).setup();
  const controller = new AbortController();

  const applying = config.apply("/x", { signal: controller.signal });
  await waitUntil(() => handlerCalled, "the event handler is running");
  await waitUntil(() => transport.callsOf("Poll").length === 2, "the second poll is open");
  controller.abort();
  held.release(finishedCancelled());

  await assert.rejects(promptly(applying), CancelledError);
});

test("after a cancel the rejection does not wait for a stuck state task", async () => {
  let saveCalled = false;
  const store: StateStore = {
    load: () => [],
    save: () => {
      saveCalled = true;
      return new Promise<void>(() => {});
    },
    exists: () => false,
    clear: () => {},
  };
  const held = heldPoll();
  const transport = engine().queue("Poll", saveTask, held.answer);
  const config = await configWith(new Client(transport), { stateStore: store }).setup();
  const controller = new AbortController();

  const applying = config.apply("/x", { signal: controller.signal });
  await waitUntil(() => saveCalled, "the state store is saving");
  await waitUntil(() => transport.callsOf("Poll").length === 2, "the second poll is open");
  controller.abort();
  held.release(finishedCancelled());

  await assert.rejects(promptly(applying), CancelledError);
});

test("after a cancel the rejection does not wait for a stuck function task", async () => {
  let functionCalled = false;
  class Stuck {
    @Func([], String)
    stuck(): Promise<string> {
      functionCalled = true;
      return new Promise<string>(() => {});
    }
  }
  const registry = new LocalRegistry();
  registry.registerFunctions(new Stuck());
  const held = heldPoll();
  const transport = engine().queue("Poll", () => functionTask("stuck"), held.answer);
  const config = await configWith(new Client(transport), { registries: [registry] }).setup();
  const controller = new AbortController();

  const applying = config.apply("/x", { signal: controller.signal });
  await waitUntil(() => functionCalled, "the function is running");
  await waitUntil(() => transport.callsOf("Poll").length === 2, "the second poll is open");
  controller.abort();
  held.release(finishedCancelled());

  await assert.rejects(promptly(applying), CancelledError);
});

// -- the abort listener -------------------------------------------------------

test("the abort listener is present while the operation runs", async () => {
  const held = heldPoll();
  const transport = engine().queue("Poll", held.answer);
  const config = await open(transport);
  const controller = new AbortController();

  const applying = config.apply("/x", { signal: controller.signal });
  await waitUntil(() => transport.callsOf("Poll").length === 1, "the poll is open");

  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  held.release(finished());
  await promptly(applying);
});

test("an operation that finishes before the abort removes the abort listener", async () => {
  const transport = engine().queue("Poll", finished);
  const config = await open(transport);
  const controller = new AbortController();

  await promptly(config.apply("/x", { signal: controller.signal }));

  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("an abort after the operation finished sends no Cancel", async () => {
  const transport = engine().queue("Poll", finished);
  const config = await open(transport);
  const controller = new AbortController();

  await promptly(config.apply("/x", { signal: controller.signal }));
  controller.abort();
  await settleEventLoop();

  assert.equal(transport.callsOf("Cancel").length, 0);
});

test("an operation that fails before the abort removes the abort listener", async () => {
  const transport = engine().queue("Poll", finishedFailed);
  const config = await open(transport);
  const controller = new AbortController();

  await assert.rejects(promptly(config.apply("/x", { signal: controller.signal })), ConfigError);

  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

// -- an engine refusing the Cancel --------------------------------------------

test("a late invalid_argument answering Cancel does not replace the cancellation", async () => {
  const held = heldPoll();
  const transport = engine()
    .always("Cancel", () => failed("invalid_argument", "no operation is running with that id"))
    .queue("Poll", held.answer);
  const config = await open(transport);
  const controller = new AbortController();

  const applying = config.apply("/x", { signal: controller.signal });
  await waitUntil(() => transport.callsOf("Poll").length === 1, "the poll is open");
  controller.abort();
  await waitUntil(() => transport.callsOf("Cancel").length === 1, "Cancel is sent");
  held.release(finishedCancelled());

  await assert.rejects(promptly(applying), CancelledError);
});

test("a late invalid_argument answering Cancel is ignored when the operation had already succeeded", async () => {
  const held = heldPoll();
  const transport = engine()
    .always("Cancel", () => failed("invalid_argument", "no operation is running with that id"))
    .queue("Poll", held.answer);
  const config = await open(transport);
  const controller = new AbortController();

  const applying = config.apply("/x", { signal: controller.signal });
  await waitUntil(() => transport.callsOf("Poll").length === 1, "the poll is open");
  controller.abort();
  await waitUntil(() => transport.callsOf("Cancel").length === 1, "Cancel is sent");
  held.release(finished());

  await assert.doesNotReject(promptly(applying));
});

test("a Cancel the transport cannot deliver leaves the poll to report the end", async () => {
  const held = heldPoll();
  const transport = engine()
    .always("Cancel", () => {
      throw new Error("the pipe has gone");
    })
    .queue("Poll", held.answer);
  const config = await open(transport);
  const controller = new AbortController();

  const applying = config.apply("/x", { signal: controller.signal });
  await waitUntil(() => transport.callsOf("Poll").length === 1, "the poll is open");
  controller.abort();
  await waitUntil(() => transport.callsOf("Cancel").length === 1, "Cancel is sent");
  held.release(finishedCancelled());

  await assert.rejects(promptly(applying), CancelledError);
});
