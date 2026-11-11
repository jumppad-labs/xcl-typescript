/** Events written to a logger at the levels and with the messages Go's logging bridge uses. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { create, type MessageInitShape } from "@bufbuild/protobuf";

import { Event, toLogger, type LevelLogger } from "../../src/events.js";
import { ClassMap } from "../../src/hydrate.js";
import { EventSchema } from "../../src/internal/core/xcl/core/v1/core_pb.js";
import { eventFields, eventLevel, eventMessage } from "../../src/internal/logbridge.js";

function event(init: MessageInitShape<typeof EventSchema>): Event {
  return new Event(create(EventSchema, init), new ClassMap([]));
}

function meta(value: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** A logger with the four level methods that records each call's level and arguments. */
function recordingLogger(): LevelLogger & { calls: { level: string; args: unknown[] }[] } {
  const calls: { level: string; args: unknown[] }[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      calls.push({ level, args });
    };
  return { calls, debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
}

test("a start event is info", () => {
  assert.equal(eventLevel(event({ operation: "create", phase: "start" })), "info");
});

test("a success event is info", () => {
  assert.equal(eventLevel(event({ operation: "create", phase: "success" })), "info");
});

test("an error event is error", () => {
  assert.equal(eventLevel(event({ operation: "create", phase: "error" })), "error");
});

test("a blocked event is warn", () => {
  assert.equal(eventLevel(event({ operation: "create", phase: "blocked" })), "warn");
});

test("a log event at debug is debug", () => {
  assert.equal(eventLevel(event({ operation: "create", phase: "log", metaJson: meta({ level: "debug", message: "hi" }) })), "debug");
});

test("a log event at warn is warn", () => {
  assert.equal(eventLevel(event({ operation: "create", phase: "log", metaJson: meta({ level: "warn", message: "hi" }) })), "warn");
});

test("a log event at error is error", () => {
  assert.equal(eventLevel(event({ operation: "create", phase: "log", metaJson: meta({ level: "error", message: "hi" }) })), "error");
});

test("a log event with an unknown level is info", () => {
  assert.equal(eventLevel(event({ operation: "create", phase: "log", metaJson: meta({ level: "loud", message: "hi" }) })), "info");
});

test("a lifecycle event's message is its operation and phase", () => {
  assert.equal(eventMessage(event({ operation: "create", phase: "success" })), "create success");
});

test("a log event's message is its own", () => {
  assert.equal(eventMessage(event({ operation: "create", phase: "log", metaJson: meta({ level: "info", message: "pulling image" }) })), "pulling image");
});

test("the fields hold the event's details under Go's names in Go's order", () => {
  const fields = eventFields(
    event({ source: "core", operation: "create", phase: "success", resourceId: "resource.slow.one", resourceType: "slow", file: "main.xcl", durationNano: 1_500_000n, metaJson: meta({ zeta: 1, alpha: "a" }) }),
  );
  assert.deepEqual(Object.keys(fields), ["source", "operation", "phase", "resource", "type", "file", "duration", "alpha", "zeta"]);
  assert.equal(fields.resource, "resource.slow.one");
  assert.equal(fields.duration, 1.5);
});

test("the fields leave out details that are not set", () => {
  assert.deepEqual(eventFields(event({ operation: "apply", phase: "start" })), { operation: "apply", phase: "start" });
});

test("a log event's fields leave out its level and message", () => {
  const fields = eventFields(event({ operation: "create", phase: "log", metaJson: meta({ level: "info", message: "hi", image: "nginx" }) }));
  assert.deepEqual(fields, { operation: "create", phase: "log", image: "nginx" });
});

test("an error event's fields hold the error", () => {
  const fields = eventFields(event({ operation: "create", phase: "error", error: { code: "provider", message: "it broke" } }));
  assert.equal((fields.error as Error).message, "it broke");
});

test("the fields never hold the event itself", () => {
  const source = event({ operation: "create", phase: "success" });
  assert.ok(!Object.values(eventFields(source)).includes(source));
});

test("toLogger writes fields then message by default", () => {
  const logger = recordingLogger();
  toLogger(logger)(event({ source: "core", operation: "create", phase: "success" }));
  assert.deepEqual(logger.calls, [{ level: "info", args: [{ source: "core", operation: "create", phase: "success" }, "create success"] }]);
});

test("toLogger writes message then fields when asked", () => {
  const logger = recordingLogger();
  toLogger(logger, { order: "message-first" })(event({ source: "core", operation: "create", phase: "success" }));
  assert.deepEqual(logger.calls, [{ level: "info", args: ["create success", { source: "core", operation: "create", phase: "success" }] }]);
});

test("toLogger writes an error event at error", () => {
  const logger = recordingLogger();
  toLogger(logger)(event({ operation: "create", phase: "error" }));
  assert.equal(logger.calls[0]?.level, "error");
});

test("toLogger writes a blocked event at warn", () => {
  const logger = recordingLogger();
  toLogger(logger)(event({ operation: "create", phase: "blocked" }));
  assert.equal(logger.calls[0]?.level, "warn");
});

test("toLogger writes a log event at its own level with its own message", () => {
  const logger = recordingLogger();
  toLogger(logger)(event({ operation: "create", phase: "log", metaJson: meta({ level: "debug", message: "pulling" }) }));
  assert.deepEqual(logger.calls, [{ level: "debug", args: [{ operation: "create", phase: "log" }, "pulling"] }]);
});

test("toLogger calls the level method on the logger itself", () => {
  const seen: unknown[] = [];
  const logger = {
    name: "app",
    debug(): void {},
    info(this: { name: string }): void {
      seen.push(this.name);
    },
    warn(): void {},
    error(): void {},
  };
  toLogger(logger)(event({ operation: "create", phase: "start" }));
  assert.deepEqual(seen, ["app"]);
});
