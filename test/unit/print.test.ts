/** Printing an error's report and a change summary in one call, with hand-built reports. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";

import { Diff } from "../../src/diff.js";
import { fromProto, type XclError } from "../../src/errors.js";
import { terminal, type Formatter } from "../../src/highlight/formatters.js";
import { Kind, type Token } from "../../src/highlight/kinds.js";
import { defaultTheme } from "../../src/highlight/theme.js";
import { ErrorSchema, TokenSchema, type TokenKind } from "../../src/internal/core/xcl/core/v1/core_pb.js";
import { formatError, printDiff, printError } from "../../src/print.js";

const SHORT_DETAIL = 'Blocks of type "timeout" are not expected here.';

const LONG_DETAIL = 'Blocks of type "timeout" are not expected here. Did you mean to define an argument called "timeout" instead, as an attribute with an equals sign?';

function protoToken(kind: number, text: string): ReturnType<typeof create<typeof TokenSchema>> {
  return create(TokenSchema, { kind: kind as TokenKind, text });
}

function reportError(detail: string): XclError {
  const report = [
    protoToken(Kind.Error, "Error"),
    protoToken(Kind.Summary, ": Unsupported block type"),
    protoToken(Kind.Text, "\n\n"),
    protoToken(Kind.Location, "  on main.xcl line 7, in app.api, field timeout[0]:"),
    protoToken(Kind.Text, "\n"),
    protoToken(Kind.Gutter, "     7 | "),
    protoToken(Kind.Text, "  "),
    protoToken(Kind.Error, "timeout"),
    protoToken(Kind.Text, " {\n\n"),
    protoToken(Kind.Detail, detail),
    protoToken(Kind.Text, "\n"),
  ];
  return fromProto(create(ErrorSchema, { code: "config", message: "main.xcl:7,3-10: Unsupported block type", report }));
}

/** A writer that keeps what is written to it. */
function capture(): { write(chunk: string): void; text: string } {
  return {
    text: "",
    write(chunk: string): void {
      this.text += chunk;
    },
  };
}

function detailLines(printed: string): string[] {
  return printed.slice(printed.indexOf("Blocks of type")).replace(/\n+$/, "").split("\n");
}

const REPORT_TEXT = `Error: Unsupported block type

  on main.xcl line 7, in app.api, field timeout[0]:
     7 |   timeout {

${SHORT_DETAIL}
`;

test("printing an xcl error writes its report", () => {
  const out = capture();
  printError(reportError(SHORT_DETAIL), { out });
  assert.equal(out.text, REPORT_TEXT);
});

test("formatError returns exactly what printError writes", () => {
  const error = reportError(LONG_DETAIL);
  const out = capture();
  printError(error, { out });
  assert.equal(formatError(error), out.text);
});

test("printing with no writer goes to standard error at call time", () => {
  const original = process.stderr.write;
  let written = "";
  process.stderr.write = ((chunk: string) => {
    written += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    printError(new Error("boom"));
  } finally {
    process.stderr.write = original;
  }
  assert.equal(written, "boom\n");
});

test("detail wraps at 80 columns by default", () => {
  const out = capture();
  printError(reportError(LONG_DETAIL), { out });
  assert.deepEqual(detailLines(out.text), [
    'Blocks of type "timeout" are not expected here. Did you mean to define an',
    'argument called "timeout" instead, as an attribute with an equals sign?',
  ]);
});

test("detail wraps at a chosen width", () => {
  const out = capture();
  printError(reportError(LONG_DETAIL), { out, width: 40 });
  assert.deepEqual(detailLines(out.text), [
    'Blocks of type "timeout" are not',
    "expected here. Did you mean to define an",
    'argument called "timeout" instead, as an',
    "attribute with an equals sign?",
  ]);
});

test("a width of 0 never wraps", () => {
  const out = capture();
  printError(reportError(LONG_DETAIL), { out, width: 0 });
  assert.deepEqual(detailLines(out.text), [LONG_DETAIL]);
});

test("a width of null never wraps", () => {
  const out = capture();
  printError(reportError(LONG_DETAIL), { out, width: null });
  assert.deepEqual(detailLines(out.text), [LONG_DETAIL]);
});

test("a plain error prints its message", () => {
  const out = capture();
  printError(new Error("boom"), { out });
  assert.equal(out.text, "boom\n");
});

test("a plain error formats as its message", () => {
  assert.equal(formatError(new Error("boom")), "boom\n");
});

test("an xcl error with no report prints its message", () => {
  const out = capture();
  printError(fromProto(create(ErrorSchema, { code: "not_found", message: "no such entity" })), { out });
  assert.equal(out.text, "no such entity\n");
});

test("a value that is not an error prints its text form", () => {
  const out = capture();
  printError(42, { out });
  assert.equal(out.text, "42\n");
});

test("a value whose string conversion throws still prints", () => {
  const value = Object.create(null) as object;
  const out = capture();
  printError(value, { out });
  assert.equal(out.text, "[Object: null prototype] {}\n");
});

test("an error whose message getter throws still prints", () => {
  const error = new Error("hidden");
  Object.defineProperty(error, "message", {
    get() {
      throw new Error("no message");
    },
  });
  const out = capture();
  assert.doesNotThrow(() => {
    printError(error, { out });
  });
});

test("printing with no format chosen writes no colour on a terminal", () => {
  const out = Object.assign(capture(), { isTTY: true });
  printError(reportError(SHORT_DETAIL), { out });
  assert.doesNotMatch(out.text, /\x1b\[/);
});

test("printing with a terminal format writes colour", () => {
  const out = capture();
  printError(reportError(SHORT_DETAIL), { out, formatter: terminal });
  assert.ok(out.text.startsWith("\x1b[1;31mError\x1b[0m\x1b[1m: Unsupported block type\x1b[0m\n\n"));
});

test("a user's format receives the whole report at once, with the writer and theme", () => {
  const error = reportError(SHORT_DETAIL);
  const out = capture();
  const calls: { out: unknown; theme: unknown; tokens: readonly Token[] }[] = [];
  const recording: Formatter = (writer, theme, tokens) => {
    calls.push({ out: writer, theme, tokens });
    writer.write("recorded\n");
  };
  printError(error, { out, formatter: recording });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.out, out);
  assert.equal(calls[0]?.theme, defaultTheme);
  assert.deepEqual(calls[0]?.tokens, error.tokens);
  assert.equal(out.text, "recorded\n");
});

const DIFF_TOKENS: readonly Token[] = [
  { kind: Kind.Summary, text: "Diff: 1 to create." },
  { kind: Kind.Text, text: "\n\n" },
  { kind: Kind.Inserted, text: '+ resource "recording" "one"' },
  { kind: Kind.Text, text: "\n" },
];

function labelledDiff(): Diff {
  return Diff.fromJSON(new TextEncoder().encode("{}"), DIFF_TOKENS);
}

test("printing a change summary writes its text", () => {
  const out = capture();
  printDiff(labelledDiff(), { out });
  assert.equal(out.text, 'Diff: 1 to create.\n\n+ resource "recording" "one"\n');
});

test("printing a change summary in terminal colour writes colour", () => {
  const out = capture();
  printDiff(labelledDiff(), { out, formatter: terminal });
  assert.ok(out.text.includes('\x1b[32m+ resource "recording" "one"\x1b[0m'));
});

test("a change summary goes to standard output by default", () => {
  const original = process.stdout.write;
  let written = "";
  process.stdout.write = ((chunk: string) => {
    written += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    printDiff(labelledDiff());
  } finally {
    process.stdout.write = original;
  }
  assert.equal(written, 'Diff: 1 to create.\n\n+ resource "recording" "one"\n');
});

test("a user's format receives a change summary's whole text in one call", () => {
  const out = capture();
  const calls: (readonly Token[])[] = [];
  const recording: Formatter = (writer, _theme, tokens) => {
    calls.push(tokens);
    writer.write("recorded\n");
  };
  printDiff(labelledDiff(), { out, formatter: recording });
  assert.deepEqual(calls, [DIFF_TOKENS]);
  assert.equal(out.text, "recorded\n");
});

test("printing a diff with no labelled text throws TypeError", () => {
  const out = capture();
  assert.throws(() => {
    printDiff(Diff.fromJSON(new TextEncoder().encode("{}")), { out });
  }, TypeError);
  assert.equal(out.text, "");
});
