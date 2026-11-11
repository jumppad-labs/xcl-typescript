import assert from "node:assert/strict";
import { Console } from "node:console";
import { Writable } from "node:stream";
import { test } from "node:test";
import { inspect } from "node:util";

import { create } from "@bufbuild/protobuf";

import * as errors from "../../src/errors.js";
import { fromProto, type XclError } from "../../src/errors.js";
import { ErrorSchema, TokenKind } from "../../src/internal/core/xcl/core/v1/core_pb.js";

const DETAIL = 'Blocks of type "timeout" are not expected here. Did you mean to define an argument called "timeout" instead, as an attribute with an equals sign?';

const PLAIN_REPORT =
  "Error: Unsupported block type\n" +
  "\n" +
  "  on main.xcl line 2:\n" +
  "   2:   timeout {\n" +
  "\n" +
  'Blocks of type "timeout" are not expected here. Did you mean to define an\n' +
  'argument called "timeout" instead, as an attribute with an equals sign?';

const COLOURED_REPORT =
  "\x1b[1;31mError\x1b[0m: \x1b[1mUnsupported block type\x1b[0m\n" +
  "\n" +
  "  on main.xcl line 2:\n" +
  "\x1b[2m   2: \x1b[0m  timeout {\n" +
  "\n" +
  'Blocks of type "timeout" are not expected here. Did you mean to define an\n' +
  'argument called "timeout" instead, as an attribute with an equals sign?';

function errorWithReport(): XclError {
  return fromProto(
    create(ErrorSchema, {
      code: "config",
      message: "the configuration is invalid",
      report: [
        { kind: TokenKind.ERROR, text: "Error" },
        { kind: TokenKind.TEXT, text: ": " },
        { kind: TokenKind.SUMMARY, text: "Unsupported block type" },
        { kind: TokenKind.TEXT, text: "\n\n  on " },
        { kind: TokenKind.LOCATION, text: "main.xcl line 2" },
        { kind: TokenKind.TEXT, text: ":\n" },
        { kind: TokenKind.GUTTER, text: "   2: " },
        { kind: TokenKind.TEXT, text: "  timeout {\n\n" },
        { kind: TokenKind.DETAIL, text: DETAIL },
        { kind: TokenKind.TEXT, text: "\n\n" },
      ],
    }),
  );
}

function errorWithoutReport(): XclError {
  return fromProto(create(ErrorSchema, { code: "not_found", message: "no such entity" }));
}

function collectingStream(): { stream: Writable; written: () => string } {
  let text = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done): void {
      text += chunk.toString();
      done();
    },
  });
  return { stream, written: () => text };
}

test("a message of several lines becomes one line joined with semicolons", () => {
  const error = fromProto(create(ErrorSchema, { code: "config", message: "main.xcl:2,3-10: Unsupported block type\nmain.xcl:5,1-4: Missing name" }));

  assert.equal(error.message, "main.xcl:2,3-10: Unsupported block type; main.xcl:5,1-4: Missing name");
});

test("a message with several problems holds no line break", () => {
  const error = fromProto(
    create(ErrorSchema, {
      code: "config",
      message: "main.xcl:3,7-12: missing image\nother.xcl:9,1-5: bad port\nother.xcl:12,2-4: bad host",
      causes: [
        create(ErrorSchema, { code: "config", message: "missing image", details: { file: "main.xcl", line: "3", column: "7" } }),
        create(ErrorSchema, { code: "config", message: "bad port", details: { file: "other.xcl", line: "9", column: "1" } }),
        create(ErrorSchema, { code: "config", message: "bad host", details: { file: "other.xcl", line: "12", column: "2" } }),
      ],
    }),
  );

  assert.equal(error.problems.length, 3);
  assert.equal(error.message, "main.xcl:3,7-12: missing image; other.xcl:9,1-5: bad port; other.xcl:12,2-4: bad host");
  assert.equal(error.message.includes("\n"), false);
  assert.equal(error.message.includes("\r"), false);
});

test("a message's blank lines are dropped", () => {
  const error = fromProto(create(ErrorSchema, { code: "config", message: "first problem\n\n   \nsecond problem\n" }));

  assert.equal(error.message, "first problem; second problem");
});

test("a message's Windows line breaks are joined like any other", () => {
  const error = fromProto(create(ErrorSchema, { code: "config", message: "first problem\r\nsecond problem" }));

  assert.equal(error.message, "first problem; second problem");
});

test("the space around each line of a message is removed", () => {
  const error = fromProto(create(ErrorSchema, { code: "config", message: "  first problem  \n\tsecond problem\t" }));

  assert.equal(error.message, "first problem; second problem");
});

test("a message of one line is left as it is", () => {
  const error = fromProto(create(ErrorSchema, { code: "not_found", message: "no such entity" }));

  assert.equal(error.message, "no such entity");
});

test("tokens are empty without a report", () => {
  const error = errorWithoutReport();

  assert.deepEqual(error.tokens, []);
});

test("tokens are not enumerable without a report", () => {
  const error = errorWithoutReport();

  assert.equal(Object.getOwnPropertyDescriptor(error, "tokens")?.enumerable, false);
  assert.equal(Object.keys(error).includes("tokens"), false);
});

test("tokens are not enumerable with a report", () => {
  const error = errorWithReport();

  assert.equal(Object.getOwnPropertyDescriptor(error, "tokens")?.enumerable, false);
  assert.equal(Object.keys(error).includes("tokens"), false);
});

test("tokens hold the report in order", () => {
  const error = errorWithReport();

  assert.deepEqual(error.tokens, [
    { kind: 1301, text: "Error" },
    { kind: 0, text: ": " },
    { kind: 1401, text: "Unsupported block type" },
    { kind: 0, text: "\n\n  on " },
    { kind: 1402, text: "main.xcl line 2" },
    { kind: 0, text: ":\n" },
    { kind: 1403, text: "   2: " },
    { kind: 0, text: "  timeout {\n\n" },
    { kind: 1404, text: DETAIL },
    { kind: 0, text: "\n\n" },
  ]);
});

test("tokens keep an unknown kind as its number", () => {
  const error = fromProto(
    create(ErrorSchema, {
      code: "config",
      message: "the configuration is invalid",
      report: [
        { kind: TokenKind.ERROR, text: "Error" },
        { kind: 1199 as TokenKind, text: "// from a later engine" },
      ],
    }),
  );

  assert.deepEqual(error.tokens, [
    { kind: 1301, text: "Error" },
    { kind: 1199, text: "// from a later engine" },
  ]);
});

test("report is the plain text of the report, wrapped at 80 columns", () => {
  const error = errorWithReport();

  assert.equal(error.report, PLAIN_REPORT);
});

test("report has its trailing line breaks removed", () => {
  const error = fromProto(create(ErrorSchema, { code: "config", message: "the configuration is invalid", report: [{ kind: TokenKind.TEXT, text: "one line of report\n\n\n" }] }));

  assert.equal(error.report, "one line of report");
});

test("a long source line in the report is not wrapped while detail is", () => {
  const error = fromProto(
    create(ErrorSchema, {
      code: "config",
      message: "the configuration is invalid",
      report: [
        { kind: TokenKind.GUTTER, text: "   3: " },
        { kind: TokenKind.TEXT, text: "  value = " },
        { kind: TokenKind.STRING, text: '"this is a quoted string held in the configuration that goes on for far longer than eighty columns"' },
        { kind: TokenKind.TEXT, text: "\n\n" },
        { kind: TokenKind.DETAIL, text: DETAIL },
      ],
    }),
  );

  assert.equal(
    error.report,
    '   3:   value = "this is a quoted string held in the configuration that goes on for far longer than eighty columns"\n' +
      "\n" +
      'Blocks of type "timeout" are not expected here. Did you mean to define an\n' +
      'argument called "timeout" instead, as an attribute with an equals sign?',
  );
});

test("report is an own enumerable accessor", () => {
  const error = errorWithReport();

  const descriptor = Object.getOwnPropertyDescriptor(error, "report");

  assert.equal(typeof descriptor?.get, "function");
  assert.equal(descriptor?.enumerable, true);
});

test("report is among an error's keys when it has a report", () => {
  const error = errorWithReport();

  assert.ok(Object.keys(error).includes("report"));
});

test("report is absent from an error's keys without a report", () => {
  const error = errorWithoutReport();

  assert.equal(Object.keys(error).includes("report"), false);
});

test("report is undefined and not an own property without a report", () => {
  const error = errorWithoutReport();

  assert.equal(error.report, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(error, "report"), undefined);
});

test("problems are among the keys of an error with a report", () => {
  const error = errorWithReport();

  assert.ok(Object.keys(error).includes("problems"));
});

test("problems are among the keys of an error without a report", () => {
  const error = errorWithoutReport();

  assert.ok(Object.keys(error).includes("problems"));
});

test("JSON.stringify carries report", () => {
  const error = errorWithReport();

  const parsed = JSON.parse(JSON.stringify(error)) as { report?: string };

  assert.equal(parsed.report, PLAIN_REPORT);
});

test("JSON.stringify holds no report for an error without one", () => {
  const error = errorWithoutReport();

  const parsed = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;

  assert.equal(Object.keys(parsed).includes("report"), false);
});

test("Object.assign carries report", () => {
  const error = errorWithReport();

  const copy = Object.assign({}, error) as { report?: string };

  assert.equal(copy.report, PLAIN_REPORT);
});

test("stack is the first line, then the plain report, then the frames", () => {
  const error = errorWithReport();

  const header = `ConfigError: the configuration is invalid\n${PLAIN_REPORT}\n`;
  const stack = error.stack ?? "";

  assert.ok(stack.startsWith(`${header}    at `), stack);
  const frames = stack.slice(header.length).split("\n");
  assert.ok(frames.length > 0);
  for (const frame of frames) {
    assert.ok(frame.startsWith("    at "), frame);
  }
});

test("the first line of stack carries the subclass's name", () => {
  const error = fromProto(create(ErrorSchema, { code: "provider", message: "the provider failed", report: [{ kind: TokenKind.TEXT, text: "the report" }] }));

  assert.ok(error instanceof errors.ProviderError);
  assert.ok((error.stack ?? "").startsWith("ProviderError: the provider failed\nthe report\n    at "), error.stack);
});

test("an error with no stack frames has the report at the end of its stack", () => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    const error = errorWithReport();

    assert.equal(error.stack, `ConfigError: the configuration is invalid\n${PLAIN_REPORT}`);
  } finally {
    Error.stackTraceLimit = limit;
  }
});

test("inspecting with colours on shows the report in colour", () => {
  const error = errorWithReport();

  const output = inspect(error, { colors: true });

  assert.ok(output.includes("\x1b[1;31mError\x1b[0m"), output);
  assert.ok(output.startsWith(`ConfigError: the configuration is invalid\n${COLOURED_REPORT}\n    at `), output);
});

test("inspecting with colours on does not show the plain report", () => {
  const error = errorWithReport();

  const output = inspect(error, { colors: true });

  assert.equal(output.includes(PLAIN_REPORT), false);
});

test("inspecting with colours on colours the report beneath a first line whose message contains the whole report", () => {
  const error = fromProto(
    create(ErrorSchema, {
      code: "config",
      message: "Error: boom",
      report: [
        { kind: TokenKind.ERROR, text: "Error" },
        { kind: TokenKind.TEXT, text: ": boom" },
      ],
    }),
  );

  const output = inspect(error, { colors: true });

  assert.ok(output.startsWith("ConfigError: Error: boom\n\x1b[1;31mError\x1b[0m: boom\n    at "), JSON.stringify(output));
});

test("inspecting with colours off shows the plain report with no colour codes", () => {
  const error = errorWithReport();

  const output = inspect(error, { colors: false });

  assert.equal(output.includes("\x1b["), false);
  assert.ok(output.startsWith(`ConfigError: the configuration is invalid\n${PLAIN_REPORT}\n    at `), output);
});

test("inspecting without options shows the plain report with no colour codes", () => {
  const error = errorWithReport();

  const output = inspect(error);

  assert.equal(output.includes("\x1b["), false);
  assert.ok(output.includes(PLAIN_REPORT), output);
});

test("console.error shows the plain report on a console without colour", () => {
  const error = errorWithReport();
  const { stream, written } = collectingStream();
  const target = new Console({ stdout: stream, stderr: stream, colorMode: false });

  target.error(error);

  assert.equal(written().includes("\x1b["), false);
  assert.ok(written().includes(PLAIN_REPORT), written());
});

test("console.error shows the coloured report on a console with colour", () => {
  const error = errorWithReport();
  const { stream, written } = collectingStream();
  const target = new Console({ stdout: stream, stderr: stream, colorMode: true });

  target.error(error);

  assert.ok(written().includes(COLOURED_REPORT), written());
});

test("inspecting an error with no report is Node's default output", () => {
  const error = errorWithoutReport();

  assert.equal(inspect(error), inspect(error, { customInspect: false }));
});

test("inspecting an error with no report with colours on is Node's default output", () => {
  const error = errorWithoutReport();

  assert.equal(inspect(error, { colors: true }), inspect(error, { colors: true, customInspect: false }));
});

test("inspecting an error with no report starts with its name and message and has frames", () => {
  const error = errorWithoutReport();

  const output = inspect(error);

  assert.ok(output.startsWith("NotFoundError: no such entity\n    at "), output);
});

test("inspecting an error with no report shows no report", () => {
  const error = errorWithoutReport();

  const output = inspect(error);

  assert.doesNotMatch(output, /report:/);
  assert.doesNotMatch(output, /tokens:/);
});

test("Node's fatal path, which turns custom inspection off, shows the report through stack and the property as a getter", () => {
  const error = errorWithReport();

  const output = inspect(error, { customInspect: false });

  assert.ok(output.includes(PLAIN_REPORT), output);
  assert.match(output, /report: \[Getter\]/);
});

test("a cause holds its own report", () => {
  const error = fromProto(
    create(ErrorSchema, {
      code: "config",
      message: "the configuration is invalid",
      causes: [
        create(ErrorSchema, {
          code: "config",
          message: "missing image",
          details: { file: "main.xcl", line: "3", column: "7" },
          report: [
            { kind: TokenKind.ERROR, text: "Error" },
            { kind: TokenKind.TEXT, text: ": image is required\n" },
          ],
        }),
      ],
    }),
  );

  const cause = error.causes[0];

  assert.equal(cause?.report, "Error: image is required");
  assert.deepEqual(cause?.tokens, [
    { kind: 1301, text: "Error" },
    { kind: 0, text: ": image is required\n" },
  ]);
  assert.ok((cause?.stack ?? "").startsWith("ConfigError: missing image\nError: image is required\n    at "), cause?.stack);
});

test("an error whose only report is on its cause holds no report of its own", () => {
  const error = fromProto(
    create(ErrorSchema, {
      code: "config",
      message: "the configuration is invalid",
      causes: [create(ErrorSchema, { code: "config", message: "missing image", report: [{ kind: TokenKind.TEXT, text: "the cause's report" }] })],
    }),
  );

  assert.equal(error.report, undefined);
  assert.deepEqual(error.tokens, []);
});
