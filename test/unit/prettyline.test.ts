/**
 * The pretty logger's line layout, held to the lines Go's example writes. The
 * expected lines are the ones xcl-python's tests hold, which were produced by
 * running Go's example with the event at a fixed time in UTC.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

process.env.TZ = "UTC";

import { create, type MessageInitShape } from "@bufbuild/protobuf";

import { Event } from "../../src/events.js";
import { ClassMap } from "../../src/hydrate.js";
import { EventSchema } from "../../src/internal/core/xcl/core/v1/core_pb.js";
import type { LogLevel } from "../../src/internal/logbridge.js";
import { formatLine, formatRecord, goDuration, goFloat, type Styler } from "../../src/internal/prettyline.js";

function at(hour: number, minute: number): Date {
  return new Date(Date.UTC(2026, 0, 2, hour, minute, 5));
}

function nanos(time: Date): bigint {
  return BigInt(time.getTime()) * 1_000_000n;
}

type EventInit = MessageInitShape<typeof EventSchema> & { meta?: Record<string, unknown>; at?: Date };

function event(init: EventInit = {}): Event {
  const { meta, at: time, ...rest } = init;
  return new Event(
    create(EventSchema, {
      timeUnixNano: nanos(time ?? at(15, 4)),
      source: "core",
      operation: "create",
      phase: "start",
      ...(meta === undefined ? {} : { metaJson: new TextEncoder().encode(JSON.stringify(meta)) }),
      ...rest,
    }),
    new ClassMap([]),
  );
}

function line(source: Event, level: LogLevel = "info", message = "create start"): string {
  return formatLine(source, level, message);
}

function valueLine(value: unknown): string {
  return line(event({ meta: { value } }));
}

/** Wraps each styled piece as `<style>text</>`, so a test sees which style each piece got. */
const recording: Styler = (text, style) => (style === "" ? text : `<${style}>${text}</>`);

test("the time at midnight is 12 AM", () => {
  assert.equal(line(event({ at: at(0, 4) })), "12:04AM INFO create start source=core operation=create phase=start\n");
});

test("the time at noon is 12 PM", () => {
  assert.equal(line(event({ at: at(12, 0) })), "12:00PM INFO create start source=core operation=create phase=start\n");
});

test("the time in the afternoon is Go's kitchen time", () => {
  assert.equal(line(event()), "3:04PM INFO create start source=core operation=create phase=start\n");
});

test("debug is labelled DEBU", () => {
  const source = event({ operation: "apply", phase: "log", meta: { level: "debug", message: "decided every entity" } });
  assert.equal(line(source, "debug", "decided every entity"), "3:04PM DEBU decided every entity source=core operation=apply phase=log\n");
});

test("warn is labelled WARN", () => {
  const source = event({ phase: "blocked", resourceId: "resource.cache.main" });
  assert.equal(line(source, "warn", "create blocked"), "3:04PM WARN create blocked source=core operation=create phase=blocked resource=resource.cache.main\n");
});

test("error is labelled ERRO", () => {
  const source = event({ phase: "error", resourceId: "resource.cache.main", error: { code: "internal", message: "boom" } });
  assert.equal(line(source, "error", "create error"), "3:04PM ERRO create error source=core operation=create phase=error resource=resource.cache.main error=boom\n");
});

test("an empty message is left out", () => {
  assert.equal(line(event({ operation: "apply", phase: "log", meta: { level: "info" } }), "info", ""), "3:04PM INFO source=core operation=apply phase=log\n");
});

test("the attributes are in Go's order", () => {
  const source = event({
    phase: "error",
    resourceType: "recording.one",
    resourceId: "resource.recording.one",
    file: "/work/main.xcl",
    durationNano: 1_500_000n,
    error: { code: "internal", message: "boom" },
    meta: { zeta: "z", alpha: "a" },
  });
  assert.equal(
    line(source, "error", "create error"),
    "3:04PM ERRO create error source=core operation=create phase=error resource=resource.recording.one type=recording.one file=/work/main.xcl duration=1.5ms error=boom alpha=a zeta=z\n",
  );
});

test("the details are sorted", () => {
  assert.equal(line(event({ operation: "apply", meta: { c: "3", a: "1", b: "2" } }), "info", "apply start"), "3:04PM INFO apply start source=core operation=apply phase=start a=1 b=2 c=3\n");
});

test("a log event's level and message are not repeated", () => {
  const source = event({ source: "TemplatePlugin", phase: "log", resourceId: "template.welcome", meta: { level: "info", message: "rendered template", path: "/tmp/welcome.txt" } });
  assert.equal(line(source, "info", "rendered template"), "3:04PM INFO rendered template source=TemplatePlugin operation=create phase=log resource=template.welcome path=/tmp/welcome.txt\n");
});

test("an error's value is its message, quoted when it holds spaces", () => {
  const source = event({ phase: "error", error: { code: "internal", message: "the provider failed" } });
  assert.equal(line(source, "error", "create error"), '3:04PM ERRO create error source=core operation=create phase=error error="the provider failed"\n');
});

test("a fractional millisecond duration is Go's", () => {
  assert.equal(goDuration(1.5), "1.5ms");
});

test("a whole millisecond duration is Go's", () => {
  assert.equal(goDuration(5), "5ms");
});

test("a microsecond duration is Go's", () => {
  assert.equal(goDuration(0.999), "999µs");
});

test("a nanosecond duration is Go's", () => {
  assert.equal(goDuration(0.000_25), "250ns");
});

test("a second duration is Go's", () => {
  assert.equal(goDuration(1500), "1.5s");
});

test("a minute duration is Go's", () => {
  assert.equal(goDuration(61_000), "1m1s");
});

test("an hour duration is Go's", () => {
  assert.equal(goDuration(7_200_000), "2h0m0s");
});

test("a duration is written on the line", () => {
  assert.equal(line(event({ phase: "success", durationNano: 999_000n }), "info", "create success"), "3:04PM INFO create success source=core operation=create phase=success duration=999µs\n");
});

test("a zero duration is left out", () => {
  assert.equal(line(event({ phase: "success" }), "info", "create success"), "3:04PM INFO create success source=core operation=create phase=success\n");
});

test("an integer is written as Go writes it", () => {
  assert.equal(valueLine(42), "3:04PM INFO create start source=core operation=create phase=start value=42\n");
});

test("a whole number is written as an integer", () => {
  assert.equal(valueLine(1234567), "3:04PM INFO create start source=core operation=create phase=start value=1234567\n");
});

test("a fraction is written as Go writes a float", () => {
  assert.equal(valueLine(1.5), "3:04PM INFO create start source=core operation=create phase=start value=1.5\n");
});

test("a negative fraction is written as Go writes a float", () => {
  assert.equal(valueLine(-2.5), "3:04PM INFO create start source=core operation=create phase=start value=-2.5\n");
});

test("a number beyond the safe integers is written as Go writes a float", () => {
  assert.equal(valueLine(1.5e300), "3:04PM INFO create start source=core operation=create phase=start value=1.5e+300\n");
});

test("Go's float form keeps six digits plain", () => {
  assert.equal(goFloat(123456), "123456");
});

test("Go's float form uses an exponent from seven digits", () => {
  assert.equal(goFloat(1234567), "1.234567e+06");
});

test("Go's float form writes one million with an exponent", () => {
  assert.equal(goFloat(1e6), "1e+06");
});

test("Go's float form keeps a small fraction plain", () => {
  assert.equal(goFloat(0.0001), "0.0001");
});

test("Go's float form writes a tiny fraction with an exponent", () => {
  assert.equal(goFloat(1e-5), "1e-05");
});

test("true is written as Go writes it", () => {
  assert.equal(valueLine(true), "3:04PM INFO create start source=core operation=create phase=start value=true\n");
});

test("false is written as Go writes it", () => {
  assert.equal(valueLine(false), "3:04PM INFO create start source=core operation=create phase=start value=false\n");
});

test("null is written as Go's nil", () => {
  assert.equal(valueLine(null), "3:04PM INFO create start source=core operation=create phase=start value=<nil>\n");
});

test("a list is written as Go writes a slice, quoted for its spaces", () => {
  assert.equal(valueLine(["a", 1, true]), '3:04PM INFO create start source=core operation=create phase=start value="[a 1 true]"\n');
});

test("an empty list is written as Go writes a slice", () => {
  assert.equal(valueLine([]), "3:04PM INFO create start source=core operation=create phase=start value=[]\n");
});

test("a map is written as Go writes a map, with sorted keys", () => {
  assert.equal(valueLine({ b: 1, a: "x" }), '3:04PM INFO create start source=core operation=create phase=start value="map[a:x b:1]"\n');
});

test("a nested map is written as Go writes it", () => {
  assert.equal(valueLine({ a: ["x", { k: "v" }] }), '3:04PM INFO create start source=core operation=create phase=start value="map[a:[x map[k:v]]]"\n');
});

test("an empty map is written as Go writes it", () => {
  assert.equal(valueLine({}), "3:04PM INFO create start source=core operation=create phase=start value=map[]\n");
});

test("a value with a space is quoted", () => {
  assert.equal(valueLine("a b"), '3:04PM INFO create start source=core operation=create phase=start value="a b"\n');
});

test("a value with an equals sign is quoted", () => {
  assert.equal(valueLine("a=b"), '3:04PM INFO create start source=core operation=create phase=start value="a=b"\n');
});

test("a quote in a value is escaped", () => {
  assert.equal(valueLine('say "hi"'), '3:04PM INFO create start source=core operation=create phase=start value="say \\"hi\\""\n');
});

test("a tab in a value is escaped", () => {
  assert.equal(valueLine("a\tb"), '3:04PM INFO create start source=core operation=create phase=start value="a\\tb"\n');
});

test("a control character in a value is escaped", () => {
  assert.equal(valueLine("a\x01b"), '3:04PM INFO create start source=core operation=create phase=start value="a\\x01b"\n');
});

test("a no-break space in a value is escaped", () => {
  assert.equal(valueLine("a b"), '3:04PM INFO create start source=core operation=create phase=start value="a\\u00a0b"\n');
});

test("printable Unicode is not quoted", () => {
  assert.equal(valueLine("héllo"), "3:04PM INFO create start source=core operation=create phase=start value=héllo\n");
});

test("an empty value is written as two quotes", () => {
  assert.equal(valueLine(""), '3:04PM INFO create start source=core operation=create phase=start value=""\n');
});

test("a multi-line value last is indented", () => {
  assert.equal(valueLine("first\nsecond"), "3:04PM INFO create start source=core operation=create phase=start\n  value=\n  │ first\n  │ second\n");
});

test("a multi-line value followed by an attribute is indented", () => {
  assert.equal(line(event({ meta: { a: "first\nsecond", b: "after" } })), "3:04PM INFO create start source=core operation=create phase=start\n  a=\n  │ first\n  │ second\n b=after\n");
});

test("a multi-line value with a trailing line break is indented", () => {
  assert.equal(valueLine("first\nsecond\n"), "3:04PM INFO create start source=core operation=create phase=start\n  value=\n  │ first\n  │ second\n\n");
});

test("a multi-line value is escaped without quoting", () => {
  assert.equal(valueLine('say "hi"\nthen\tgo'), '3:04PM INFO create start source=core operation=create phase=start\n  value=\n  │ say "hi"\n  │ then\\tgo\n');
});

test("a line that is not an event's own writes the given attributes", () => {
  assert.equal(
    formatRecord(at(15, 4), "warn", "unable to show configuration", [
      ["resource", "resource.cache.main"],
      ["error", "boom"],
    ]),
    "3:04PM WARN unable to show configuration resource=resource.cache.main error=boom\n",
  );
});

test("the source key and value are styled", () => {
  assert.ok(formatLine(event(), "info", "create start", recording).includes(" <magenta>source</><dim>=</><bold magenta>core</>"));
});

test("the operation key and value are styled", () => {
  assert.ok(formatLine(event(), "info", "create start", recording).includes(" <yellow>operation</><dim>=</><bold yellow>create</>"));
});

test("the entity key and value are styled", () => {
  assert.ok(formatLine(event({ resourceId: "resource.cache.main" }), "info", "create start", recording).includes(" <cyan>resource</><dim>=</><bold cyan>resource.cache.main</>"));
});

test("another key is dim and its value plain", () => {
  assert.ok(formatLine(event(), "info", "create start", recording).includes(" <dim>phase</><dim>=</>start"));
});

test("a quoted value is styled with its quotes", () => {
  assert.ok(formatLine(event({ resourceId: "a b" }), "info", "create start", recording).includes(' <cyan>resource</><dim>=</><bold cyan>"a b"</>'));
});

test("a multi-line value's gutter is dim", () => {
  assert.ok(formatLine(event({ meta: { value: "first\nsecond" } }), "info", "create start", recording).includes("\n  <dim>value</><dim>=</>\n<dim>  │ </>first\n<dim>  │ </>second\n"));
});

test("the time and message are unstyled", () => {
  assert.ok(formatLine(event(), "info", "create start", recording).startsWith("3:04PM <bold cyan>INFO</> create start "));
});

test("the debug label is styled", () => {
  assert.ok(formatLine(event(), "debug", "create start", recording).startsWith("3:04PM <bold blue>DEBU</> "));
});

test("the warn label is styled", () => {
  assert.ok(formatLine(event(), "warn", "create start", recording).startsWith("3:04PM <bold yellow>WARN</> "));
});

test("the error label is styled", () => {
  assert.ok(formatLine(event(), "error", "create start", recording).startsWith("3:04PM <bold red>ERRO</> "));
});

test("the layout itself writes no escape code", () => {
  assert.doesNotMatch(line(event({ resourceId: "resource.cache.main", meta: { value: "first\nsecond" } })), /\x1b/);
});
