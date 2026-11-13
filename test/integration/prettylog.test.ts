/**
 * The pretty logger against the real engine: one line of setup, each event a
 * line, created entities shown beneath them. Every test applies configuration
 * with the recording fixture plugin, whose provider fills in `output` on create,
 * and reads what the pretty logger wrote.
 */

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, type TestContext } from "node:test";

import { ConfigError, Config, EventDataLevel, LocalRegistry, prettylog, type Event, type LevelLogger } from "../../src/index.js";
import { isolateHome, missingEngine, missingPlugin, pluginPath, RECORDING_PLUGIN, ROOT, testDirectory, writeConfig } from "../helpers/engine.js";

const needsPlugin = missingEngine() || missingPlugin(RECORDING_PLUGIN);
isolateHome();

/** The start of every event line: Go's kitchen time and a level label. */
const EVENT_LINE = /^\d{1,2}:\d{2}(AM|PM) (DEBU|INFO|WARN|ERRO) /;

const UNSUPPORTED_BLOCK = join(ROOT, "test", "integration", "fixtures", "unsupported-block", "main.xcl");

let previousNoColor: string | undefined;

beforeEach(() => {
  previousNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
});

afterEach(() => {
  if (previousNoColor === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = previousNoColor;
  }
});

/** A writer keeping what is written, as a terminal when `isTTY` is true. */
function captured(isTTY = false): { text: string; isTTY: boolean; write(chunk: string): void } {
  return {
    text: "",
    isTTY,
    write(chunk: string): void {
      this.text += chunk;
    },
  };
}

function oneResource(directory: string): string {
  return writeConfig(directory, "main.xcl", `resource "recording" "one" {\n  log   = ${JSON.stringify(join(directory, "log.jsonl"))}\n  value = "a"\n}\n`);
}

function twoResources(directory: string): string {
  const log = JSON.stringify(join(directory, "log.jsonl"));
  return writeConfig(directory, "main.xcl", `resource "recording" "one" {\n  log   = ${log}\n  value = "a"\n}\n\nresource "recording" "two" {\n  log   = ${log}\n  value = "b"\n}\n`);
}

function builtins(directory: string): string {
  const leaf = join(directory, "leaf");
  mkdirSync(leaf, { recursive: true });
  writeConfig(leaf, "leaf.xcl", 'variable "colour" {\n  default = "blue"\n}\n');
  return writeConfig(
    directory,
    "main.xcl",
    `variable "name" {\n  default = "a"\n}\n\nresource "recording" "one" {\n  log   = ${JSON.stringify(join(directory, "log.jsonl"))}\n  value = variable.name\n}\n\noutput "out" {\n  value = resource.recording.one.output\n}\n\nmodule "leaf" {\n  source = "./leaf"\n}\n`,
  );
}

/** Applies `path` with the pretty logger handler given, in a state directory of its own. */
async function applyWith(t: TestContext, path: string, onEvent: (event: Event) => Promise<void>, eventData: EventDataLevel = EventDataLevel.Processed): Promise<void> {
  const local = new LocalRegistry();
  local.registerExternalPlugin(pluginPath(RECORDING_PLUGIN));
  const config = await new Config({ registries: [local], statePath: join(testDirectory(t), "state"), onEvent, eventData }).setup();
  t.after(() => config.close());
  await config.apply(path);
}

function eventLines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "" && !line.startsWith(" "));
}

function lineIndex(lines: readonly string[], needle: string): number {
  const index = lines.findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, `no line holds ${needle}:\n${lines.join("\n")}`);
  return index;
}

/** `text` with each line's time and every duration replaced, the parts that differ between runs. */
function normalised(text: string): string {
  return text.replace(/^\d{1,2}:\d{2}(AM|PM) /gm, "<time> ").replace(/duration=\S+/g, "duration=<duration>");
}

test("set up in one line, a run writes one line per event at info or above", { skip: needsPlugin }, async (t) => {
  const out = captured();
  await applyWith(t, oneResource(testDirectory(t)), prettylog.handler({ out }));

  const lines = eventLines(out.text);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.match(line, EVENT_LINE);
  }
  assert.ok(lines.some((line) => line.includes(" INFO apply start ")));
  assert.ok(lines.some((line) => line.includes(" INFO apply success ")));
  const success = lines[lineIndex(lines, " INFO create success ")] as string;
  assert.ok(success.includes(" source=core "));
  assert.ok(success.includes(" operation=create "));
  assert.ok(success.includes(" phase=success "));
  assert.ok(success.includes(" resource=resource.recording.one "));
  assert.ok(success.includes(" type=recording.one "));
});

test("the default level writes no debug lines", { skip: needsPlugin }, async (t) => {
  const out = captured();
  await applyWith(t, oneResource(testDirectory(t)), prettylog.handler({ out }));
  assert.ok(!out.text.includes(" DEBU "));
});

test("the configuration, with a value the provider filled in, follows the creation line before the next event's line", { skip: needsPlugin }, async (t) => {
  const out = captured();
  await applyWith(t, oneResource(testDirectory(t)), prettylog.handler({ out }));

  const lines = out.text.split("\n");
  const success = lineIndex(lines, " INFO create success ");
  assert.equal(lines[success + 1], '  resource "recording" "one" {');
  const block: string[] = [];
  for (const line of lines.slice(success + 1)) {
    if (!line.startsWith(" ")) {
      break;
    }
    block.push(line);
  }
  assert.equal(block[block.length - 1], "  }");
  assert.ok(block.some((line) => /output\s+=\s+"one-a"/.test(line)), block.join("\n"));
  assert.match(lines[success + 1 + block.length] as string, EVENT_LINE);
});

test("the same run through an application's logger writes the same lines", { skip: needsPlugin }, async (t) => {
  const directory = testDirectory(t);
  const path = oneResource(directory);
  const stream = captured();
  await applyWith(t, path, prettylog.handler({ out: stream }));

  let throughLogger = "";
  const write = (_fields: unknown, message: unknown): void => {
    throughLogger += `${String(message)}\n`;
  };
  const logger: LevelLogger = { debug: write, info: write, warn: write, error: write };
  await applyWith(t, path, prettylog.handler({ logger }));

  assert.equal(normalised(throughLogger), normalised(stream.text));
});

test("at warn there is no configuration and no info line", { skip: needsPlugin }, async (t) => {
  const out = captured();
  await applyWith(t, oneResource(testDirectory(t)), prettylog.handler({ out, level: "warn" }));
  assert.deepEqual(
    out.text.split("\n").filter((line) => line.startsWith(" ")),
    [],
  );
  assert.ok(!out.text.includes(" INFO "));
});

test("at debug, debug events appear beside the info lines", { skip: needsPlugin }, async (t) => {
  const out = captured();
  await applyWith(t, oneResource(testDirectory(t)), prettylog.handler({ out, level: "debug" }));
  const lines = eventLines(out.text);
  assert.ok(lines.some((line) => line.includes(" DEBU ")), out.text);
  assert.ok(lines.some((line) => line.includes(" INFO create success ")));
});

test("XCL_LOG_LEVEL set to WARN, read when asked, makes the run terse", { skip: needsPlugin }, async (t) => {
  const previous = process.env[prettylog.LEVEL_ENV];
  process.env[prettylog.LEVEL_ENV] = "WARN";
  t.after(() => {
    if (previous === undefined) {
      delete process.env[prettylog.LEVEL_ENV];
    } else {
      process.env[prettylog.LEVEL_ENV] = previous;
    }
  });
  const out = captured();
  await applyWith(t, oneResource(testDirectory(t)), prettylog.handler({ out, level: prettylog.levelFromEnv() }));
  assert.ok(!out.text.includes(" INFO "));
});

test("an unsupported block writes the error line followed by the report", { skip: needsPlugin }, async (t) => {
  const out = captured();
  await assert.rejects(applyWith(t, UNSUPPORTED_BLOCK, prettylog.handler({ out })), ConfigError);

  const lines = out.text.split("\n");
  const error = lineIndex(lines, " ERRO ");
  const report: string[] = [];
  for (const line of lines.slice(error + 1)) {
    if (line !== "" && !line.startsWith(" ")) {
      break;
    }
    report.push(line);
  }
  assert.equal(report[0], "  Error: Unsupported block type");
  assert.ok(report.some((line) => line.includes(`on ${UNSUPPORTED_BLOCK} line 7`)), report.join("\n"));
  assert.ok(report.some((line) => line.startsWith("       7 |   nope {")), report.join("\n"));
});

test("an unsupported block's report is written once", { skip: needsPlugin }, async (t) => {
  const out = captured();
  await assert.rejects(applyWith(t, UNSUPPORTED_BLOCK, prettylog.handler({ out })), ConfigError);
  assert.equal(out.text.split("Error: Unsupported block type").length - 1, 1);
});

test("at warn, an unsupported block's report still follows its error line", { skip: needsPlugin }, async (t) => {
  const out = captured();
  await assert.rejects(applyWith(t, UNSUPPORTED_BLOCK, prettylog.handler({ out, level: "warn" })), ConfigError);
  const lines = out.text.split("\n");
  assert.equal(lines[lineIndex(lines, " ERRO ") + 1], "  Error: Unsupported block type");
  assert.ok(!out.text.includes(" INFO "));
});

test("a terminal stream gets colour codes in its lines and configuration", { skip: needsPlugin }, async (t) => {
  const out = captured(true);
  await applyWith(t, oneResource(testDirectory(t)), prettylog.handler({ out }));
  assert.ok(out.text.includes("\x1b[1;35mcore\x1b[0m"));
  assert.ok(out.text.includes("\x1b[1;33mcreate\x1b[0m"));
  assert.ok(out.text.includes("\x1b[1;36mresource.recording.one\x1b[0m"));
  assert.ok(out.text.includes('\x1b[1;35mresource\x1b[0m \x1b[36m"recording"\x1b[0m'), out.text);
});

test("a terminal stream with NO_COLOR set gets no colour codes", { skip: needsPlugin }, async (t) => {
  process.env.NO_COLOR = "1";
  const out = captured(true);
  await applyWith(t, oneResource(testDirectory(t)), prettylog.handler({ out }));
  assert.ok(out.text.includes("create success"));
  assert.doesNotMatch(out.text, /\x1b/);
});

test("a captured stream gets no colour codes", { skip: needsPlugin }, async (t) => {
  const out = captured(false);
  await applyWith(t, oneResource(testDirectory(t)), prettylog.handler({ out }));
  assert.ok(out.text.includes("create success"));
  assert.doesNotMatch(out.text, /\x1b/);
});

test("two entities with no entity data write the guidance once and no configuration or warning", { skip: needsPlugin }, async (t) => {
  const out = captured();
  await applyWith(t, twoResources(testDirectory(t)), prettylog.handler({ out }), EventDataLevel.None);
  assert.equal(out.text.split("configuration not shown").length - 1, 1);
  assert.ok(out.text.includes('hint="create the configuration with eventData: EventDataLevel.Processed"'));
  assert.deepEqual(
    out.text.split("\n").filter((line) => line.startsWith(" ")),
    [],
  );
  assert.ok(!out.text.includes("unable to show configuration"));
  assert.equal(out.text.split(" INFO create success ").length - 1, 2);
});

test("a variable, an output and a module write no configuration and no warning", { skip: needsPlugin }, async (t) => {
  const out = captured();
  await applyWith(t, builtins(testDirectory(t)), prettylog.handler({ out }));
  assert.ok(!out.text.includes("unable to show configuration"));
  assert.deepEqual(
    out.text.split("\n").filter((line) => line.startsWith("  ") && line.endsWith("{")),
    ['  resource "recording" "one" {'],
  );
  const lines = eventLines(out.text);
  assert.ok(lines.some((line) => line.includes("resource=variable.name") && line.includes(" create success ")));
  assert.ok(lines.some((line) => line.includes("resource=output.out") && line.includes(" create success ")));
});
