/**
 * The pretty logger: every event as a readable line, with configuration and
 * reports beneath. Events are built by hand or delivered by a configuration
 * over the fake transport. Every expected output is written out here; the
 * layout of a line itself is held to Go's in prettyline.test.ts. The time zone
 * is UTC so the time at the start of each line is known.
 */

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

process.env.TZ = "UTC";

import { create, fromBinary, type MessageInitShape } from "@bufbuild/protobuf";

import { createConfigWith } from "../../src/config.js";
import { ConfigError, InvalidArgumentError } from "../../src/errors.js";
import { Event, EventDataLevel, type LevelLogger } from "../../src/events.js";
import type { Writer } from "../../src/highlight/formatters.js";
import { ClassMap } from "../../src/hydrate.js";
import { Client } from "../../src/internal/client.js";
import {
  CreateConfigResponseSchema,
  EncodeSavedEntityRequestSchema,
  EncodeSavedEntityResponseSchema,
  ErrorSchema,
  EventSchema,
  PollResponseSchema,
  StartOperationResponseSchema,
  TokenKind,
  TokenSchema,
} from "../../src/internal/core/xcl/core/v1/core_pb.js";
import { linkEvent, type EventLink } from "../../src/internal/event-link.js";
import type { CallResult } from "../../src/internal/transport.js";
import { handler, LEVEL_ENV, levelFromEnv, type LogLevel } from "../../src/prettylog.js";
import { failed, FakeTransport, ok } from "../helpers/fake-transport.js";

// -- events, reports and transports -------------------------------------------

const EVENT_TIME = new Date(Date.UTC(2026, 0, 2, 15, 4, 5));
const EVENT_NANOS = BigInt(EVENT_TIME.getTime()) * 1_000_000n;

const encoder = new TextEncoder();

const WEB_RECORD = encoder.encode('{"meta": {"id": "app.web", "name": "web", "type": "app"}, "image": "nginx"}');
const API_RECORD = encoder.encode('{"meta": {"id": "app.api", "name": "api", "type": "app"}, "image": "httpd"}');

type TokenInit = MessageInitShape<typeof TokenSchema>;

const WEB_TOKENS: TokenInit[] = [
  { kind: TokenKind.BLOCK_TYPE, text: "app" },
  { kind: TokenKind.TEXT, text: " " },
  { kind: TokenKind.NAME_LABEL, text: '"web"' },
  { kind: TokenKind.TEXT, text: " {\n  " },
  { kind: TokenKind.ATTRIBUTE, text: "image" },
  { kind: TokenKind.TEXT, text: " = " },
  { kind: TokenKind.STRING, text: '"nginx"' },
  { kind: TokenKind.TEXT, text: "\n}\n" },
];

const API_TOKENS: TokenInit[] = [
  { kind: TokenKind.BLOCK_TYPE, text: "app" },
  { kind: TokenKind.TEXT, text: " " },
  { kind: TokenKind.NAME_LABEL, text: '"api"' },
  { kind: TokenKind.TEXT, text: " {\n  " },
  { kind: TokenKind.ATTRIBUTE, text: "image" },
  { kind: TokenKind.TEXT, text: " = " },
  { kind: TokenKind.STRING, text: '"httpd"' },
  { kind: TokenKind.TEXT, text: "\n}\n" },
];

const WEB_BLOCK = '  app "web" {\n    image = "nginx"\n  }\n';
const API_BLOCK = '  app "api" {\n    image = "httpd"\n  }\n';

const WEB_CREATE_START = "3:04PM INFO create start source=core operation=create phase=start resource=app.web type=app\n";
const WEB_CREATE_SUCCESS = "3:04PM INFO create success source=core operation=create phase=success resource=app.web type=app\n";
const API_CREATE_SUCCESS = "3:04PM INFO create success source=core operation=create phase=success resource=app.api type=app\n";
const APPLY_START = "3:04PM INFO apply start source=core operation=apply phase=start\n";
const APPLY_SUCCESS = "3:04PM INFO apply success source=core operation=apply phase=success\n";

const GUIDANCE = '3:04PM INFO configuration not shown: events carry no resource data hint="create the configuration with eventData: EventDataLevel.Processed"\n';

// an unsupported block's report, as the engine sends it and as it is written
const REPORT_TOKENS: TokenInit[] = [
  { kind: TokenKind.ERROR, text: "Error" },
  { kind: TokenKind.TEXT, text: ": " },
  { kind: TokenKind.SUMMARY, text: "Unsupported block type" },
  { kind: TokenKind.TEXT, text: "\n\n  on main.xcl line 3:\n" },
  { kind: TokenKind.GUTTER, text: "   3 |" },
  { kind: TokenKind.TEXT, text: ' widget "x" {\n\nBlocks of type "widget" are not expected here.\n' },
];
const REPORT = '  Error: Unsupported block type\n\n    on main.xcl line 3:\n     3 | widget "x" {\n\n  Blocks of type "widget" are not expected here.\n';

// the same report with a second problem after it, for a closing error holding two
const TWO_PROBLEM_REPORT_TOKENS: TokenInit[] = [
  { kind: TokenKind.ERROR, text: "Error" },
  { kind: TokenKind.TEXT, text: ": " },
  { kind: TokenKind.SUMMARY, text: "Unsupported block type" },
  { kind: TokenKind.TEXT, text: "\n\n  on main.xcl line 3:\n" },
  { kind: TokenKind.GUTTER, text: "   3 |" },
  { kind: TokenKind.TEXT, text: ' widget "x" {\n\nBlocks of type "widget" are not expected here.\n' },
  { kind: TokenKind.TEXT, text: "\n" },
  { kind: TokenKind.ERROR, text: "Error" },
  { kind: TokenKind.TEXT, text: ": " },
  { kind: TokenKind.SUMMARY, text: "Missing name" },
  { kind: TokenKind.TEXT, text: "\n\n  on main.xcl line 9:\n" },
  { kind: TokenKind.GUTTER, text: "   9 |" },
  { kind: TokenKind.TEXT, text: " app {\n" },
];
const TWO_PROBLEM_REPORT =
  '  Error: Unsupported block type\n\n    on main.xcl line 3:\n     3 | widget "x" {\n\n  Blocks of type "widget" are not expected here.\n\n  Error: Missing name\n\n    on main.xcl line 9:\n     9 | app {\n';

const PARSE_ERROR = '3:04PM ERRO parse error source=core operation=parse phase=error file=main.xcl error="unsupported block"\n';
const VALIDATE_ERROR = '3:04PM ERRO validate error source=core operation=validate phase=error resource=widget.x error="unsupported block"\n';
const APPLY_ERROR = '3:04PM ERRO apply error source=core operation=apply phase=error error="configuration is invalid"\n';

type ErrorInit = MessageInitShape<typeof ErrorSchema>;
type EventInit = MessageInitShape<typeof EventSchema>;

/** One problem, an unsupported block, with its report. */
function unsupportedBlock(): ErrorInit {
  return {
    code: "config",
    message: "unsupported block",
    details: { file: "main.xcl", line: "3", summary: "Unsupported block type" },
    report: REPORT_TOKENS,
  };
}

/** A second problem, a block missing its name, with no report of its own. */
function missingName(): ErrorInit {
  return { code: "config", message: "missing name", details: { file: "main.xcl", line: "9", summary: "Missing name" } };
}

/** An operation's closing error holding the unsupported block, and its report. */
function invalidWithOneProblem(): ErrorInit {
  return { code: "config", message: "configuration is invalid", causes: [unsupportedBlock()], report: REPORT_TOKENS };
}

/** An operation's closing error holding two problems, and their report. */
function invalidWithTwoProblems(): ErrorInit {
  return { code: "config", message: "configuration is invalid", causes: [unsupportedBlock(), missingName()], report: TWO_PROBLEM_REPORT_TOKENS };
}

/** An event built by hand at EVENT_TIME, a core create start unless `init` says otherwise. */
function handBuilt(init: EventInit = {}): Event {
  return new Event(create(EventSchema, { timeUnixNano: EVENT_NANOS, source: "core", operation: "create", phase: "start", ...init }), new ClassMap([]));
}

function webCreateSuccess(data?: Uint8Array): Event {
  return handBuilt({ phase: "success", resourceType: "app", resourceId: "app.web", ...(data === undefined ? {} : { data }) });
}

function parseErrorEvent(): Event {
  return handBuilt({ operation: "parse", phase: "error", file: "main.xcl", error: unsupportedBlock() });
}

function applyStartEvent(): Event {
  return handBuilt({ operation: "apply", phase: "start" });
}

function closingErrorEvent(error: ErrorInit): Event {
  return handBuilt({ operation: "apply", phase: "error", error });
}

/** A Poll answer carrying one core event at EVENT_TIME. */
function eventTask(init: EventInit): CallResult {
  return ok(PollResponseSchema, { task: { case: "event", value: { timeUnixNano: EVENT_NANOS, source: "core", ...init } } });
}

function webCreateSuccessTask(data?: Uint8Array): CallResult {
  return eventTask({ operation: "create", phase: "success", resourceType: "app", resourceId: "app.web", ...(data === undefined ? {} : { data }) });
}

function apiCreateSuccessTask(data?: Uint8Array): CallResult {
  return eventTask({ operation: "create", phase: "success", resourceType: "app", resourceId: "app.api", ...(data === undefined ? {} : { data }) });
}

function applySuccessTask(): CallResult {
  return eventTask({ operation: "apply", phase: "success" });
}

function finished(): CallResult {
  return ok(PollResponseSchema, { task: { case: "finished", value: { operationId: 1n } } });
}

/** The engine's answer to EncodeSavedEntity: the text and its labelled tokens. */
function encoded(tokens: TokenInit[]): CallResult {
  return ok(EncodeSavedEntityResponseSchema, { text: encoder.encode(tokens.map((token) => token.text ?? "").join("")), tokens });
}

/** An engine that creates a configuration and runs an apply whose polls answer `polls`, then the finished task. */
function engine(...polls: (() => CallResult)[]): FakeTransport {
  return new FakeTransport()
    .always("CreateConfig", () => ok(CreateConfigResponseSchema, { handle: 7n }))
    .always("StartApply", () => ok(StartOperationResponseSchema, { operationId: 1n }))
    .queue("Poll", ...polls, finished);
}

async function applyThrough(transport: FakeTransport, onEvent: (event: Event) => Promise<void>, eventData: EventDataLevel = EventDataLevel.Processed): Promise<void> {
  const config = await createConfigWith(new Client(transport), { onEvent, eventData });
  await config.apply("main.xcl");
}

/** A writer keeping every chunk written to it. */
class Collect implements Writer {
  readonly chunks: string[] = [];

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  get text(): string {
    return this.chunks.join("");
  }
}

/** A writer that says it is a terminal. */
class TerminalCollect extends Collect {
  readonly isTTY = true;
}

/** A writer whose every write fails. */
class FailingWriter implements Writer {
  write(): void {
    throw new Error("the disk is full");
  }
}

interface LoggerCall {
  level: string;
  args: unknown[];
}

/** A logger keeping every call made to it. */
class RecordingLogger implements LevelLogger {
  readonly calls: LoggerCall[] = [];

  debug(...args: unknown[]): void {
    this.calls.push({ level: "debug", args });
  }

  info(...args: unknown[]): void {
    this.calls.push({ level: "info", args });
  }

  warn(...args: unknown[]): void {
    this.calls.push({ level: "warn", args });
  }

  error(...args: unknown[]): void {
    this.calls.push({ level: "error", args });
  }
}

/** Sets an environment variable, or removes it for undefined, until the test ends. */
function setEnv(t: TestContext, name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  t.after(() => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  });
}

/** Stands in for the configuration delivering an event; it renders nothing. */
function fakeLink(): EventLink {
  return { eventData: EventDataLevel.Processed, savedEntityTokens: async () => [] };
}

/** Stands in for the configuration delivering an event, failing to render with `failure`. */
function failingLink(failure: unknown): EventLink {
  return {
    eventData: EventDataLevel.Processed,
    savedEntityTokens: async () => {
      throw failure;
    },
  };
}

function linked(event: Event, link: EventLink): Event {
  linkEvent(event, link);
  return event;
}

// -- the level from the environment ---------------------------------------------

test("the level variable is XCL_LOG_LEVEL", () => {
  assert.equal(LEVEL_ENV, "XCL_LOG_LEVEL");
});

test("levelFromEnv reads debug", (t) => {
  setEnv(t, "XCL_LOG_LEVEL", "debug");

  assert.equal(levelFromEnv(), "debug");
});

test("levelFromEnv reads warn", (t) => {
  setEnv(t, "XCL_LOG_LEVEL", "warn");

  assert.equal(levelFromEnv(), "warn");
});

test("levelFromEnv reads error", (t) => {
  setEnv(t, "XCL_LOG_LEVEL", "error");

  assert.equal(levelFromEnv(), "error");
});

test("levelFromEnv reads info in upper case", (t) => {
  setEnv(t, "XCL_LOG_LEVEL", "INFO");

  assert.equal(levelFromEnv(), "info");
});

test("levelFromEnv reads warn in mixed case", (t) => {
  setEnv(t, "XCL_LOG_LEVEL", "WaRn");

  assert.equal(levelFromEnv(), "warn");
});

test("levelFromEnv gives info when the variable is unset", (t) => {
  setEnv(t, "XCL_LOG_LEVEL", undefined);

  assert.equal(levelFromEnv(), "info");
});

test("levelFromEnv gives info for an unknown word", (t) => {
  setEnv(t, "XCL_LOG_LEVEL", "loud");

  assert.equal(levelFromEnv(), "info");
});

test("levelFromEnv reads the variable each time it is called", (t) => {
  setEnv(t, "XCL_LOG_LEVEL", "error");
  const first = levelFromEnv();
  process.env.XCL_LOG_LEVEL = "debug";

  assert.equal(first, "error");
  assert.equal(levelFromEnv(), "debug");
});

test("the handler does not read the level variable when no level is given", async (t) => {
  setEnv(t, "XCL_LOG_LEVEL", "error");
  const out = new Collect();
  const onEvent = handler({ out });

  await onEvent(handBuilt({ resourceType: "app", resourceId: "app.web" }));

  assert.equal(out.text, WEB_CREATE_START);
});

// -- arguments -------------------------------------------------------------------

test("giving both a stream and a logger throws InvalidArgumentError", () => {
  assert.throws(() => handler({ out: new Collect(), logger: new RecordingLogger() }), InvalidArgumentError);
});

test("an invalid level throws InvalidArgumentError", () => {
  assert.throws(() => handler({ level: "loud" as LogLevel }), InvalidArgumentError);
});

test("the handler writes to process.stderr by default", async (t) => {
  setEnv(t, "NO_COLOR", "1");
  const written: string[] = [];
  const original = process.stderr.write;
  const onEvent = handler();
  let pending: Promise<void>;
  process.stderr.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    pending = onEvent(handBuilt({ resourceType: "app", resourceId: "app.web" }));
  } finally {
    process.stderr.write = original;
  }
  await pending;

  assert.deepEqual(written, [WEB_CREATE_START]);
});

// -- levels ----------------------------------------------------------------------

function debugLogEvent(): Event {
  return handBuilt({ source: "plugin", phase: "log", resourceId: "app.web", metaJson: encoder.encode(JSON.stringify({ level: "debug", message: "probing" })) });
}

test("an info handler writes nothing for a debug event", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await onEvent(debugLogEvent());

  assert.equal(out.text, "");
});

test("a debug handler writes a debug event", async () => {
  const out = new Collect();
  const onEvent = handler({ out, level: "debug" });

  await onEvent(debugLogEvent());

  assert.equal(out.text, "3:04PM DEBU probing source=plugin operation=create phase=log resource=app.web\n");
});

test("a warn handler writes nothing for an info event", async () => {
  const out = new Collect();
  const onEvent = handler({ out, level: "warn" });

  await onEvent(handBuilt({ resourceType: "app", resourceId: "app.web" }));

  assert.equal(out.text, "");
});

test("a warn handler writes a blocked event", async () => {
  const out = new Collect();
  const onEvent = handler({ out, level: "warn" });

  await onEvent(handBuilt({ phase: "blocked", resourceId: "app.web" }));

  assert.equal(out.text, "3:04PM WARN create blocked source=core operation=create phase=blocked resource=app.web\n");
});

test("an error handler writes nothing for a blocked event", async () => {
  const out = new Collect();
  const onEvent = handler({ out, level: "error" });

  await onEvent(handBuilt({ phase: "blocked", resourceId: "app.web" }));

  assert.equal(out.text, "");
});

// -- configuration beneath a creation ---------------------------------------------

test("the configuration follows a creation's line at info", async () => {
  const out = new Collect();
  const transport = engine(() => webCreateSuccessTask(WEB_RECORD), applySuccessTask).always("EncodeSavedEntity", () => encoded(WEB_TOKENS));

  await applyThrough(transport, handler({ out }));

  assert.equal(out.text, WEB_CREATE_SUCCESS + WEB_BLOCK + APPLY_SUCCESS);
});

test("the configuration follows a creation's line at debug", async () => {
  const out = new Collect();
  const transport = engine(() => webCreateSuccessTask(WEB_RECORD)).always("EncodeSavedEntity", () => encoded(WEB_TOKENS));

  await applyThrough(transport, handler({ out, level: "debug" }));

  assert.equal(out.text, WEB_CREATE_SUCCESS + WEB_BLOCK);
});

test("a warn handler shows no configuration and asks for none", async () => {
  const out = new Collect();
  const transport = engine(() => webCreateSuccessTask(WEB_RECORD)).always("EncodeSavedEntity", () => encoded(WEB_TOKENS));

  await applyThrough(transport, handler({ out, level: "warn" }));

  assert.equal(out.text, "");
  assert.equal(transport.callsOf("EncodeSavedEntity").length, 0);
});

test("an error handler shows no configuration and asks for none", async () => {
  const out = new Collect();
  const transport = engine(() => webCreateSuccessTask(WEB_RECORD)).always("EncodeSavedEntity", () => encoded(WEB_TOKENS));

  await applyThrough(transport, handler({ out, level: "error" }));

  assert.equal(out.text, "");
  assert.equal(transport.callsOf("EncodeSavedEntity").length, 0);
});

test("the configuration is asked for as tokens with computed values", async () => {
  const transport = engine(() => webCreateSuccessTask(WEB_RECORD)).always("EncodeSavedEntity", () => encoded(WEB_TOKENS));

  await applyThrough(transport, handler({ out: new Collect() }));

  const requests = transport.callsOf("EncodeSavedEntity").map((call) => fromBinary(EncodeSavedEntityRequestSchema, call.request));
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.entity, WEB_RECORD);
  assert.equal(requests[0]?.tokens, true);
  assert.equal(requests[0]?.options?.includeComputed, true);
});

test("the configuration is asked for with no other encoding choice", async () => {
  const transport = engine(() => webCreateSuccessTask(WEB_RECORD)).always("EncodeSavedEntity", () => encoded(WEB_TOKENS));

  await applyThrough(transport, handler({ out: new Collect() }));

  const options = fromBinary(EncodeSavedEntityRequestSchema, transport.callsOf("EncodeSavedEntity")[0]?.request as Uint8Array).options;
  assert.equal(options?.includeEmpty, false);
  assert.equal(options?.revealSensitive, false);
  assert.equal(options?.showReferences, false);
});

test("a creation's start shows no configuration", async () => {
  const out = new Collect();
  const transport = engine(() => eventTask({ operation: "create", phase: "start", resourceType: "app", resourceId: "app.web", data: WEB_RECORD })).always("EncodeSavedEntity", () =>
    encoded(WEB_TOKENS),
  );

  await applyThrough(transport, handler({ out }));

  assert.equal(out.text, WEB_CREATE_START);
  assert.equal(transport.callsOf("EncodeSavedEntity").length, 0);
});

test("each creation shows its own configuration", async () => {
  const out = new Collect();
  const transport = engine(
    () => webCreateSuccessTask(WEB_RECORD),
    () => apiCreateSuccessTask(API_RECORD),
    applySuccessTask,
  ).queue("EncodeSavedEntity", () => encoded(WEB_TOKENS), () => encoded(API_TOKENS));

  await applyThrough(transport, handler({ out }));

  assert.equal(out.text, WEB_CREATE_SUCCESS + WEB_BLOCK + API_CREATE_SUCCESS + API_BLOCK + APPLY_SUCCESS);
});

test("a line and its configuration arrive in one write", async () => {
  const out = new Collect();
  const transport = engine(() => webCreateSuccessTask(WEB_RECORD), applySuccessTask).always("EncodeSavedEntity", () => encoded(WEB_TOKENS));

  await applyThrough(transport, handler({ out }));

  assert.deepEqual(out.chunks, [WEB_CREATE_SUCCESS + WEB_BLOCK, APPLY_SUCCESS]);
});

test("one handler serves two configurations", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await applyThrough(engine(() => webCreateSuccessTask(WEB_RECORD)).always("EncodeSavedEntity", () => encoded(WEB_TOKENS)), onEvent);
  await applyThrough(engine(() => apiCreateSuccessTask(API_RECORD)).always("EncodeSavedEntity", () => encoded(API_TOKENS)), onEvent);

  assert.equal(out.text, WEB_CREATE_SUCCESS + WEB_BLOCK + API_CREATE_SUCCESS + API_BLOCK);
});

test("a creation built by hand without data shows nothing beneath", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await onEvent(webCreateSuccess());

  assert.equal(out.text, WEB_CREATE_SUCCESS);
});

test("a creation built by hand with data writes a warning", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await onEvent(webCreateSuccess(WEB_RECORD));

  assert.equal(out.text, WEB_CREATE_SUCCESS + '3:04PM WARN unable to show configuration resource=app.web error="the event was not delivered by a configuration"\n');
});

// -- variables, outputs and modules ------------------------------------------------

test("an entity the engine cannot encode shows nothing and writes no warning", async () => {
  const out = new Collect();
  const transport = engine(() => webCreateSuccessTask(WEB_RECORD), applySuccessTask).always("EncodeSavedEntity", () =>
    failed("not_encodable", "a variable has no configuration form"),
  );

  await applyThrough(transport, handler({ out }));

  assert.equal(out.text, WEB_CREATE_SUCCESS + APPLY_SUCCESS);
});

test("an entity the engine cannot encode does not stop the next entity's configuration", async () => {
  const out = new Collect();
  const transport = engine(
    () => webCreateSuccessTask(WEB_RECORD),
    () => apiCreateSuccessTask(API_RECORD),
  ).queue("EncodeSavedEntity", () => failed("not_encodable", "an output has no configuration form"), () => encoded(API_TOKENS));

  await applyThrough(transport, handler({ out }));

  assert.equal(out.text, WEB_CREATE_SUCCESS + API_CREATE_SUCCESS + API_BLOCK);
});

// -- render failures ---------------------------------------------------------------

test("a render failure writes one warning line and the next entity is still shown", async () => {
  const out = new Collect();
  const transport = engine(
    () => webCreateSuccessTask(WEB_RECORD),
    () => apiCreateSuccessTask(API_RECORD),
    applySuccessTask,
  ).queue("EncodeSavedEntity", () => failed("unregistered_type", "app is not registered"), () => encoded(API_TOKENS));

  await applyThrough(transport, handler({ out }));

  assert.equal(
    out.text,
    WEB_CREATE_SUCCESS + '3:04PM WARN unable to show configuration resource=app.web error="app is not registered"\n' + API_CREATE_SUCCESS + API_BLOCK + APPLY_SUCCESS,
  );
});

test("two render failures write two warnings and the apply completes", async () => {
  const out = new Collect();
  const transport = engine(
    () => webCreateSuccessTask(WEB_RECORD),
    () => apiCreateSuccessTask(API_RECORD),
    applySuccessTask,
  ).queue("EncodeSavedEntity", () => failed("unregistered_type", "app is not registered"), () => failed("plugin_load", "the app plugin failed to load"));

  await applyThrough(transport, handler({ out }));

  assert.equal(
    out.text,
    WEB_CREATE_SUCCESS +
      '3:04PM WARN unable to show configuration resource=app.web error="app is not registered"\n' +
      API_CREATE_SUCCESS +
      '3:04PM WARN unable to show configuration resource=app.api error="the app plugin failed to load"\n' +
      APPLY_SUCCESS,
  );
  assert.equal(transport.callsOf("Poll").length, 4);
});

test("a render failure's warning is a write of its own", async () => {
  const out = new Collect();
  const transport = engine(() => webCreateSuccessTask(WEB_RECORD)).always("EncodeSavedEntity", () => failed("unregistered_type", "app is not registered"));

  await applyThrough(transport, handler({ out }));

  assert.deepEqual(out.chunks, [WEB_CREATE_SUCCESS, '3:04PM WARN unable to show configuration resource=app.web error="app is not registered"\n']);
});

test("a render failure that is not an engine error writes its message", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await onEvent(linked(webCreateSuccess(WEB_RECORD), failingLink(new Error("something odd"))));

  assert.equal(out.text, WEB_CREATE_SUCCESS + '3:04PM WARN unable to show configuration resource=app.web error="something odd"\n');
});

test("a render failure with no message names its error", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await onEvent(linked(webCreateSuccess(WEB_RECORD), failingLink(new TypeError())));

  assert.equal(out.text, WEB_CREATE_SUCCESS + "3:04PM WARN unable to show configuration resource=app.web error=TypeError\n");
});

test("a render failure that is not an Error writes its text", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await onEvent(linked(webCreateSuccess(WEB_RECORD), failingLink("odd")));

  assert.equal(out.text, WEB_CREATE_SUCCESS + "3:04PM WARN unable to show configuration resource=app.web error=odd\n");
});

test("a warn handler writes no render warning and asks for no configuration", async () => {
  const out = new Collect();
  const transport = engine(
    () => webCreateSuccessTask(WEB_RECORD),
    () => eventTask({ operation: "create", phase: "blocked", resourceType: "app", resourceId: "app.api" }),
  ).always("EncodeSavedEntity", () => failed("unregistered_type", "app is not registered"));

  await applyThrough(transport, handler({ out, level: "warn" }));

  assert.equal(out.text, "3:04PM WARN create blocked source=core operation=create phase=blocked resource=app.api type=app\n");
  assert.equal(transport.callsOf("EncodeSavedEntity").length, 0);
});

// -- guidance when events carry no entity data -------------------------------------

test("the guidance is written once when events carry no data", async () => {
  const out = new Collect();
  const transport = engine(() => webCreateSuccessTask(), () => apiCreateSuccessTask());

  await applyThrough(transport, handler({ out }), EventDataLevel.None);

  assert.equal(out.text, WEB_CREATE_SUCCESS + GUIDANCE + API_CREATE_SUCCESS);
});

test("the guidance is written once for a configuration created with the default event data", async () => {
  const out = new Collect();
  const transport = engine(() => webCreateSuccessTask(), () => apiCreateSuccessTask());
  const config = await createConfigWith(new Client(transport), { onEvent: handler({ out }) });

  await config.apply("main.xcl");

  assert.equal(out.text, WEB_CREATE_SUCCESS + GUIDANCE + API_CREATE_SUCCESS);
});

test("the guidance is written once across two configurations sharing a handler", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await applyThrough(engine(() => webCreateSuccessTask()), onEvent, EventDataLevel.None);
  await applyThrough(engine(() => apiCreateSuccessTask()), onEvent, EventDataLevel.None);

  assert.equal(out.text, WEB_CREATE_SUCCESS + GUIDANCE + API_CREATE_SUCCESS);
});

test("each handler writes the guidance once of its own", async () => {
  const first = new Collect();
  const second = new Collect();

  await applyThrough(engine(() => webCreateSuccessTask()), handler({ out: first }), EventDataLevel.None);
  await applyThrough(engine(() => webCreateSuccessTask()), handler({ out: second }), EventDataLevel.None);

  assert.equal(first.text, WEB_CREATE_SUCCESS + GUIDANCE);
  assert.equal(second.text, WEB_CREATE_SUCCESS + GUIDANCE);
});

test("the guidance is a write of its own", async () => {
  const out = new Collect();
  const transport = engine(() => webCreateSuccessTask());

  await applyThrough(transport, handler({ out }), EventDataLevel.None);

  assert.deepEqual(out.chunks, [WEB_CREATE_SUCCESS, GUIDANCE]);
});

test("no guidance is written when data is on and an event carries none", async () => {
  const out = new Collect();
  const transport = engine(() => webCreateSuccessTask());

  await applyThrough(transport, handler({ out }), EventDataLevel.Processed);

  assert.equal(out.text, WEB_CREATE_SUCCESS);
  assert.equal(transport.callsOf("EncodeSavedEntity").length, 0);
});

test("no guidance is written for creations built by hand without data", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await onEvent(webCreateSuccess());
  await onEvent(webCreateSuccess());

  assert.equal(out.text, WEB_CREATE_SUCCESS + WEB_CREATE_SUCCESS);
});

test("no guidance is written above info", async () => {
  const out = new Collect();
  const transport = engine(() => webCreateSuccessTask(), () => apiCreateSuccessTask());

  await applyThrough(transport, handler({ out, level: "warn" }), EventDataLevel.None);

  assert.equal(out.text, "");
});

// -- reports beneath configuration mistakes ---------------------------------------

test("a report follows a parse error's line", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await onEvent(parseErrorEvent());

  assert.equal(out.text, PARSE_ERROR + REPORT);
});

test("a report follows a resource's error line", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await onEvent(handBuilt({ operation: "validate", phase: "error", resourceId: "widget.x", error: unsupportedBlock() }));

  assert.equal(out.text, VALIDATE_ERROR + REPORT);
});

test("a report follows its error line at debug", async () => {
  const out = new Collect();
  const onEvent = handler({ out, level: "debug" });

  await onEvent(parseErrorEvent());

  assert.equal(out.text, PARSE_ERROR + REPORT);
});

test("a report follows its error line at warn", async () => {
  const out = new Collect();
  const onEvent = handler({ out, level: "warn" });

  await onEvent(parseErrorEvent());

  assert.equal(out.text, PARSE_ERROR + REPORT);
});

test("a report follows its error line at error", async () => {
  const out = new Collect();
  const onEvent = handler({ out, level: "error" });

  await onEvent(parseErrorEvent());

  assert.equal(out.text, PARSE_ERROR + REPORT);
});

test("a report follows a closing error at error when the operation's start was below the level", async () => {
  const out = new Collect();
  const onEvent = handler({ out, level: "error" });

  await onEvent(applyStartEvent());
  await onEvent(closingErrorEvent(invalidWithOneProblem()));

  assert.equal(out.text, APPLY_ERROR + REPORT);
});

test("an error line and its report arrive in one write", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await onEvent(parseErrorEvent());

  assert.deepEqual(out.chunks, [PARSE_ERROR + REPORT]);
});

test("an error with no report writes only its line", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await onEvent(handBuilt({ operation: "parse", phase: "error", file: "main.xcl", error: { code: "config", message: "unsupported block", details: { file: "main.xcl", line: "3" } } }));

  assert.equal(out.text, PARSE_ERROR);
});

test("a closing error does not repeat a report its parse error showed", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await onEvent(applyStartEvent());
  await onEvent(parseErrorEvent());
  await onEvent(closingErrorEvent(invalidWithOneProblem()));

  assert.equal(out.text, APPLY_START + PARSE_ERROR + REPORT + APPLY_ERROR);
});

test("a closing error does not repeat a report a resource's error line showed", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await onEvent(applyStartEvent());
  await onEvent(handBuilt({ operation: "validate", phase: "error", resourceId: "widget.x", error: unsupportedBlock() }));
  await onEvent(closingErrorEvent(invalidWithOneProblem()));

  assert.equal(out.text, APPLY_START + VALIDATE_ERROR + REPORT + APPLY_ERROR);
});

test("a closing error shows its report when no earlier line showed it", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await onEvent(applyStartEvent());
  await onEvent(closingErrorEvent(invalidWithOneProblem()));

  assert.equal(out.text, APPLY_START + APPLY_ERROR + REPORT);
});

test("a closing error holding more problems than were shown writes its report", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  await onEvent(applyStartEvent());
  await onEvent(parseErrorEvent());
  await onEvent(closingErrorEvent(invalidWithTwoProblems()));

  assert.equal(out.text, APPLY_START + PARSE_ERROR + REPORT + APPLY_ERROR + TWO_PROBLEM_REPORT);
});

test("the next operation reports its closing error afresh", async () => {
  const out = new Collect();
  const onEvent = handler({ out });

  // the first operation shows its problem beneath the parse error and ends
  // without a closing error
  await onEvent(applyStartEvent());
  await onEvent(parseErrorEvent());
  // the second shows none before its closing error
  await onEvent(applyStartEvent());
  await onEvent(closingErrorEvent(invalidWithOneProblem()));

  assert.equal(out.text, APPLY_START + PARSE_ERROR + REPORT + APPLY_START + APPLY_ERROR + REPORT);
});

test("a closing error's report is not hidden by another configuration's report", async () => {
  const out = new Collect();
  const onEvent = handler({ out });
  const first = fakeLink();
  const second = fakeLink();

  await onEvent(linked(applyStartEvent(), first));
  await onEvent(linked(applyStartEvent(), second));
  // the second configuration shows its own problem
  await onEvent(linked(parseErrorEvent(), second));
  // the first has shown none, so its closing error carries the report
  await onEvent(linked(closingErrorEvent(invalidWithOneProblem()), first));

  assert.equal(out.text, APPLY_START + APPLY_START + PARSE_ERROR + REPORT + APPLY_ERROR + REPORT);
});

test("a closing error's report is not repeated when another configuration's operation starts", async () => {
  const out = new Collect();
  const onEvent = handler({ out });
  const first = fakeLink();
  const second = fakeLink();

  await onEvent(linked(applyStartEvent(), first));
  // the first configuration shows its problem
  await onEvent(linked(parseErrorEvent(), first));
  // another configuration's operation starts meanwhile
  await onEvent(linked(applyStartEvent(), second));
  // the first's closing error holds only the problem it showed
  await onEvent(linked(closingErrorEvent(invalidWithOneProblem()), first));

  assert.equal(out.text, APPLY_START + PARSE_ERROR + REPORT + APPLY_START + APPLY_ERROR);
});

test("a report appears once through a configuration", async () => {
  const out = new Collect();
  const transport = engine().queue(
    "Poll",
    () => eventTask({ operation: "apply", phase: "start" }),
    () => eventTask({ operation: "parse", phase: "error", file: "main.xcl", error: unsupportedBlock() }),
    () => eventTask({ operation: "apply", phase: "error", error: invalidWithOneProblem() }),
    () => ok(PollResponseSchema, { task: { case: "finished", value: { operationId: 1n, error: invalidWithOneProblem() } } }),
  );
  const config = await createConfigWith(new Client(transport), { onEvent: handler({ out }) });

  await assert.rejects(config.apply("main.xcl"), ConfigError);

  assert.equal(out.text, APPLY_START + PARSE_ERROR + REPORT + APPLY_ERROR);
});

test("a closing error's report appears through a configuration when no earlier line showed it", async () => {
  const out = new Collect();
  const transport = engine().queue(
    "Poll",
    () => eventTask({ operation: "apply", phase: "start" }),
    () => eventTask({ operation: "apply", phase: "error", error: invalidWithOneProblem() }),
    () => ok(PollResponseSchema, { task: { case: "finished", value: { operationId: 1n, error: invalidWithOneProblem() } } }),
  );
  const config = await createConfigWith(new Client(transport), { onEvent: handler({ out }) });

  await assert.rejects(config.apply("main.xcl"), ConfigError);

  assert.equal(out.text, APPLY_START + APPLY_ERROR + REPORT);
});

// -- colour ----------------------------------------------------------------------

const COLOURED_WEB_CREATE_SUCCESS =
  "3:04PM \x1b[1;36mINFO\x1b[0m create success" +
  " \x1b[35msource\x1b[0m\x1b[2m=\x1b[0m\x1b[1;35mcore\x1b[0m" +
  " \x1b[33moperation\x1b[0m\x1b[2m=\x1b[0m\x1b[1;33mcreate\x1b[0m" +
  " \x1b[2mphase\x1b[0m\x1b[2m=\x1b[0msuccess" +
  " \x1b[36mresource\x1b[0m\x1b[2m=\x1b[0m\x1b[1;36mapp.web\x1b[0m" +
  " \x1b[2mtype\x1b[0m\x1b[2m=\x1b[0mapp\n";

const COLOURED_WEB_BLOCK = '  \x1b[1;35mapp\x1b[0m \x1b[32m"web"\x1b[0m {\n    \x1b[34mimage\x1b[0m = \x1b[33m"nginx"\x1b[0m\n  }\n';

test("a terminal stream gets colour in the line and the configuration", async (t) => {
  setEnv(t, "NO_COLOR", undefined);
  const out = new TerminalCollect();
  const transport = engine(() => webCreateSuccessTask(WEB_RECORD)).always("EncodeSavedEntity", () => encoded(WEB_TOKENS));

  await applyThrough(transport, handler({ out }));

  assert.equal(out.text, COLOURED_WEB_CREATE_SUCCESS + COLOURED_WEB_BLOCK);
});

test("a terminal stream with NO_COLOR set gets no colour", async (t) => {
  setEnv(t, "NO_COLOR", "1");
  const out = new TerminalCollect();
  const transport = engine(() => webCreateSuccessTask(WEB_RECORD)).always("EncodeSavedEntity", () => encoded(WEB_TOKENS));

  await applyThrough(transport, handler({ out }));

  assert.equal(out.text, WEB_CREATE_SUCCESS + WEB_BLOCK);
});

test("a stream that is not a terminal gets no colour", async (t) => {
  setEnv(t, "NO_COLOR", undefined);
  const out = new Collect();
  const transport = engine(() => webCreateSuccessTask(WEB_RECORD)).always("EncodeSavedEntity", () => encoded(WEB_TOKENS));

  await applyThrough(transport, handler({ out }));

  assert.equal(out.text, WEB_CREATE_SUCCESS + WEB_BLOCK);
});

// -- through a logger ----------------------------------------------------------

const WEB_CREATE_SUCCESS_FIELDS = { source: "core", operation: "create", phase: "success", resource: "app.web", type: "app" };

test("a logger gets one call per group, fields first, with the line and its configuration as the message", async () => {
  const logger = new RecordingLogger();
  const transport = engine(() => webCreateSuccessTask(WEB_RECORD)).always("EncodeSavedEntity", () => encoded(WEB_TOKENS));

  await applyThrough(transport, handler({ logger }));

  assert.deepEqual(logger.calls, [
    {
      level: "info",
      args: [WEB_CREATE_SUCCESS_FIELDS, '3:04PM INFO create success source=core operation=create phase=success resource=app.web type=app\n  app "web" {\n    image = "nginx"\n  }'],
    },
  ]);
});

test("a logger with message-first order gets the message then the fields", async () => {
  const logger = new RecordingLogger();
  const transport = engine(() => webCreateSuccessTask(WEB_RECORD)).always("EncodeSavedEntity", () => encoded(WEB_TOKENS));

  await applyThrough(transport, handler({ logger, order: "message-first" }));

  assert.deepEqual(logger.calls, [
    {
      level: "info",
      args: ['3:04PM INFO create success source=core operation=create phase=success resource=app.web type=app\n  app "web" {\n    image = "nginx"\n  }', WEB_CREATE_SUCCESS_FIELDS],
    },
  ]);
});

test("a logger gets an error line and its report in one call at error", async () => {
  const logger = new RecordingLogger();
  const onEvent = handler({ logger });
  const sent = parseErrorEvent();

  await onEvent(sent);

  assert.deepEqual(logger.calls, [
    {
      level: "error",
      args: [
        { source: "core", operation: "parse", phase: "error", file: "main.xcl", error: sent.error },
        '3:04PM ERRO parse error source=core operation=parse phase=error file=main.xcl error="unsupported block"\n  Error: Unsupported block type\n\n    on main.xcl line 3:\n     3 | widget "x" {\n\n  Blocks of type "widget" are not expected here.',
      ],
    },
  ]);
});

test("a logger gets a blocked event at warn", async () => {
  const logger = new RecordingLogger();
  const onEvent = handler({ logger });

  await onEvent(handBuilt({ phase: "blocked", resourceId: "app.web" }));

  assert.deepEqual(logger.calls, [
    {
      level: "warn",
      args: [{ source: "core", operation: "create", phase: "blocked", resource: "app.web" }, "3:04PM WARN create blocked source=core operation=create phase=blocked resource=app.web"],
    },
  ]);
});

test("a logger gets a render warning as a call of its own at warn", async () => {
  const logger = new RecordingLogger();
  const onEvent = handler({ logger });

  await onEvent(webCreateSuccess(WEB_RECORD));

  assert.deepEqual(logger.calls, [
    { level: "info", args: [WEB_CREATE_SUCCESS_FIELDS, "3:04PM INFO create success source=core operation=create phase=success resource=app.web type=app"] },
    {
      level: "warn",
      args: [WEB_CREATE_SUCCESS_FIELDS, '3:04PM WARN unable to show configuration resource=app.web error="the event was not delivered by a configuration"'],
    },
  ]);
});

test("a logger gets the guidance as a call of its own at info", async () => {
  const logger = new RecordingLogger();
  const transport = engine(() => webCreateSuccessTask(), () => apiCreateSuccessTask());

  await applyThrough(transport, handler({ logger }), EventDataLevel.None);

  assert.deepEqual(logger.calls, [
    { level: "info", args: [WEB_CREATE_SUCCESS_FIELDS, "3:04PM INFO create success source=core operation=create phase=success resource=app.web type=app"] },
    {
      level: "info",
      args: [WEB_CREATE_SUCCESS_FIELDS, '3:04PM INFO configuration not shown: events carry no resource data hint="create the configuration with eventData: EventDataLevel.Processed"'],
    },
    {
      level: "info",
      args: [
        { source: "core", operation: "create", phase: "success", resource: "app.api", type: "app" },
        "3:04PM INFO create success source=core operation=create phase=success resource=app.api type=app",
      ],
    },
  ]);
});

test("a logger gets nothing for an event below the level", async () => {
  const logger = new RecordingLogger();
  const onEvent = handler({ logger, level: "warn" });

  await onEvent(handBuilt({ resourceType: "app", resourceId: "app.web" }));

  assert.deepEqual(logger.calls, []);
});

// -- a failing stream ----------------------------------------------------------

test("a failing stream never rejects the handler's Promise", async () => {
  const onEvent = handler({ out: new FailingWriter() });

  await assert.doesNotReject(onEvent(handBuilt({ resourceType: "app", resourceId: "app.web" })));
});

test("a failing stream never rejects the handler's Promise when a report is due", async () => {
  const onEvent = handler({ out: new FailingWriter() });

  await assert.doesNotReject(onEvent(parseErrorEvent()));
});

test("a failing stream never stops the operation", async () => {
  const transport = engine(() => webCreateSuccessTask(WEB_RECORD), applySuccessTask).always("EncodeSavedEntity", () => encoded(WEB_TOKENS));

  await assert.doesNotReject(applyThrough(transport, handler({ out: new FailingWriter() })));

  assert.equal(transport.callsOf("Poll").length, 3);
});
