/** An apply's events written through pino and winston, each set up in one line. */

import assert from "node:assert/strict";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test, type TestContext } from "node:test";

import pino from "pino";
import winston from "winston";

import { createConfig, events, LocalRegistry, type Event } from "../../src/index.js";
import { isolateHome, missingEngine, missingPlugin, pluginPath, SLOW_PLUGIN, testDirectory, writeConfig } from "../helpers/engine.js";

const needsPlugin = missingEngine() || missingPlugin(SLOW_PLUGIN);
isolateHome();

const TEXT = `resource "slow" "one" {
  delay_ms = 1
}
`;

/** Applies the configuration with `onEvent`, also counting the events delivered. */
async function apply(t: TestContext, onEvent: (event: Event) => void): Promise<Event[]> {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", TEXT);
  const local = new LocalRegistry();
  local.registerExternalPlugin(pluginPath(SLOW_PLUGIN));
  const seen: Event[] = [];
  const config = await createConfig({
    registries: [local],
    statePath: join(directory, "state"),
    onEvent: (event) => {
      seen.push(event);
      onEvent(event);
    },
  });
  t.after(() => config.close());
  await config.apply(path);
  return seen;
}

const LEVEL_NUMBERS: Readonly<Record<string, number>> = { debug: 20, info: 30, warn: 40, error: 50 };

/** The level Go's bridge writes an event at. */
function goLevel(event: Event): string {
  if (event.phase === "log") {
    return ["debug", "info", "warn", "error"].includes(event.level) ? event.level : "info";
  }
  return event.phase === "error" ? "error" : event.phase === "blocked" ? "warn" : "info";
}

/** The message Go's bridge writes an event with. */
function goMessage(event: Event): string {
  return event.phase === "log" ? event.message : `${event.operation} ${event.phase}`;
}

test("pino set up in one line writes one record per event at Go's level and message", { skip: needsPlugin }, async (t) => {
  const lines: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => lines.push(line) });

  const seen = await apply(t, events.toLogger(logger));

  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(records.length, seen.length);
  assert.ok(records.length > 0);
  records.forEach((record, index) => {
    const event = seen[index] as Event;
    assert.equal(record.msg, goMessage(event));
    assert.equal(record.level, LEVEL_NUMBERS[goLevel(event)]);
    assert.equal(record.operation, event.operation);
    assert.equal(record.phase, event.phase);
  });
});

test("winston set up in one line writes one record per event at Go's level and message", { skip: needsPlugin }, async (t) => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const logger = winston.createLogger({ level: "debug", format: winston.format.json(), transports: [new winston.transports.Stream({ stream })] });

  const seen = await apply(t, events.toLogger(logger, { order: "message-first" }));

  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(records.length, seen.length);
  records.forEach((record, index) => {
    const event = seen[index] as Event;
    assert.equal(record.message, goMessage(event));
    assert.equal(record.level, goLevel(event));
    assert.equal(record.operation, event.operation);
  });
});

test("a pino record carries the created entity's address", { skip: needsPlugin }, async (t) => {
  const lines: string[] = [];
  const logger = pino({}, { write: (line: string) => lines.push(line) });

  await apply(t, events.toLogger(logger));

  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(records.some((record) => record.msg === "create success" && record.resource === "resource.slow.one" && record.type === "slow.one"));
});
