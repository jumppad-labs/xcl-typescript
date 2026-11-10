/**
 * `interruptSignal`, against a scripted engine: when its SIGINT listener exists.
 *
 * The tests drive `process.emit("SIGINT")` in this process. Whatever else is
 * listening for SIGINT here, the test runner included, is taken away for each
 * test and put back after it, so the emit reaches only the listener under test
 * and a count of listeners is exactly the package's own.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test, type TestContext } from "node:test";

import { createConfigWith, type Config } from "../../src/config.js";
import { CancelledError, ConfigError } from "../../src/errors.js";
import { Client } from "../../src/internal/client.js";
import { CancelResponseSchema, CreateConfigResponseSchema, PollResponseSchema, StartOperationResponseSchema } from "../../src/internal/core/xcl/core/v1/core_pb.js";
import type { CallResult } from "../../src/internal/transport.js";
import { interruptSignal } from "../../src/interrupt.js";
import { FakeTransport, ok } from "../helpers/fake-transport.js";

/** Takes every SIGINT listener away for the test `t`, and puts them back when it ends. */
function clearInterruptListeners(t: TestContext): void {
  const others = process.rawListeners("SIGINT") as NodeJS.SignalsListener[];
  process.removeAllListeners("SIGINT");
  t.after(() => {
    process.removeAllListeners("SIGINT");
    for (const listener of others) {
      process.on("SIGINT", listener);
    }
  });
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

function engine(): FakeTransport {
  return new FakeTransport()
    .always("CreateConfig", () => ok(CreateConfigResponseSchema, { handle: 7n }))
    .always("StartApply", () => ok(StartOperationResponseSchema, { operationId: 1n }))
    .always("Cancel", () => ok(CancelResponseSchema));
}

function open(transport: FakeTransport): Promise<Config> {
  return createConfigWith(new Client(transport), {});
}

/** Waits for `condition`, checking between turns of the event loop. */
async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting until ${what}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// -- when the listener is added -----------------------------------------------

test("importing the package adds no SIGINT listener", () => {
  // this file has already imported the package, so a fresh process is what can
  // see the moment of the import; the compiled module sits beside this file's
  const entry = new URL("../../src/index.js", import.meta.url).href;
  const source = `
const before = process.listenerCount("SIGINT");
await import(${JSON.stringify(entry)});
console.log(before + ":" + process.listenerCount("SIGINT"));
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0:0");
});

test("interruptSignal adds its listener when called", (t) => {
  clearInterruptListeners(t);
  assert.equal(process.listenerCount("SIGINT"), 0);

  interruptSignal();

  assert.equal(process.listenerCount("SIGINT"), 1);
});

test("each call of interruptSignal adds a listener of its own", (t) => {
  clearInterruptListeners(t);

  interruptSignal();
  interruptSignal();

  assert.equal(process.listenerCount("SIGINT"), 2);
});

// -- when the listener is removed ---------------------------------------------

test("the listener is removed when the operation succeeds", async (t) => {
  clearInterruptListeners(t);
  const transport = engine().queue("Poll", finished);
  const config = await open(transport);

  const signal = interruptSignal();
  await config.apply("/x", { signal });

  assert.equal(process.listenerCount("SIGINT"), 0);
  assert.equal(signal.aborted, false);
});

test("the listener is removed when the operation fails", async (t) => {
  clearInterruptListeners(t);
  const transport = engine().queue("Poll", finishedFailed);
  const config = await open(transport);

  await assert.rejects(config.apply("/x", { signal: interruptSignal() }), ConfigError);

  assert.equal(process.listenerCount("SIGINT"), 0);
});

test("the listener is removed when the configuration is closed", async (t) => {
  clearInterruptListeners(t);
  const config = await open(engine());
  await config.close();

  await assert.rejects(config.apply("/x", { signal: interruptSignal() }));

  assert.equal(process.listenerCount("SIGINT"), 0);
});

test(
  "the listener is removed when the operation is refused for having no paths",
  async (t) => {
    clearInterruptListeners(t);
    const config = await open(engine());

    await assert.rejects(config.apply([], { signal: interruptSignal() }));

    assert.equal(process.listenerCount("SIGINT"), 0);
  },
);

// -- a SIGINT -----------------------------------------------------------------

test("a SIGINT aborts the signal and removes the listener", (t) => {
  clearInterruptListeners(t);

  const signal = interruptSignal();
  process.emit("SIGINT");

  assert.equal(signal.aborted, true);
  assert.equal(process.listenerCount("SIGINT"), 0);
});

test("a SIGINT during an operation sends Cancel and rejects it", async (t) => {
  clearInterruptListeners(t);
  let answerPoll!: (result: CallResult) => void;
  const polling = new Promise<CallResult>((resolve) => {
    answerPoll = resolve;
  });
  const transport = engine().queue("Poll", () => polling);
  const config = await open(transport);

  const applying = config.apply("/x", { signal: interruptSignal() });
  await waitUntil(() => transport.callsOf("Poll").length === 1, "the poll is open");
  process.emit("SIGINT");
  await waitUntil(() => transport.callsOf("Cancel").length === 1, "Cancel is sent");
  answerPoll(finishedCancelled());

  await assert.rejects(applying, CancelledError);
  assert.equal(process.listenerCount("SIGINT"), 0);
});

test("a SIGINT before the operation starts rejects it without starting it", async (t) => {
  clearInterruptListeners(t);
  const transport = engine();
  const config = await open(transport);

  const signal = interruptSignal();
  process.emit("SIGINT");
  await assert.rejects(config.apply("/x", { signal }), CancelledError);

  assert.equal(transport.callsOf("StartApply").length, 0);
  assert.equal(process.listenerCount("SIGINT"), 0);
});

// -- combined with a signal of the program's own ------------------------------

test("a signal combined through AbortSignal.any leaves the listener after the operation settles", async (t) => {
  clearInterruptListeners(t);
  const transport = engine().queue("Poll", finished);
  const config = await open(transport);
  const own = new AbortController();

  const signal = AbortSignal.any([interruptSignal(), own.signal]);
  await config.apply("/x", { signal });

  assert.equal(process.listenerCount("SIGINT"), 1);
});

test("a signal combined through AbortSignal.any is aborted by a SIGINT, which removes the listener", (t) => {
  clearInterruptListeners(t);
  const own = new AbortController();

  const signal = AbortSignal.any([interruptSignal(), own.signal]);
  process.emit("SIGINT");

  assert.equal(signal.aborted, true);
  assert.equal(process.listenerCount("SIGINT"), 0);
});
