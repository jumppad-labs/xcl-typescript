/**
 * The Go and Node parity programs produce the same record for every fixture.
 *
 * Each test runs xcl's `cmd/parity` and the Node program `run.ts` on one
 * fixture, both as child processes, decodes the two records and fails naming
 * the fixture and the first JSON path where they differ.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { missingEngine, missingPlugin, PLUGIN_DIRECTORY, pluginPath, RECORDING_PLUGIN, ROOT, skipReason, testDirectory } from "../helpers/engine.js";
import { parityFixturesDirectory } from "./run.js";

const PARITY_PROGRAM = `parity${process.platform === "win32" ? ".exe" : ""}`;
const RUN_NODE = fileURLToPath(new URL("./run.js", import.meta.url));

/** The keys of Go's record that belong to printing, which this package does not have yet. */
const PRINTING_KEYS = ["printed_validate", "printed_apply", "printed_entities", "printed_diff_before", "printed_diff_changed", "log", "pretty_log"];

function missingFixtures(): string | false {
  const directory = parityFixturesDirectory();
  if (!existsSync(directory)) {
    return skipReason(`the parity fixtures are not at ${directory}; set XCL_SRC to the xcl checkout`);
  }
  return false;
}

const needsPrograms = missingEngine() || missingPlugin(PARITY_PROGRAM) || missingPlugin(RECORDING_PLUGIN) || missingFixtures();

type JsonObject = Record<string, unknown>;

/** A path at which two values differ, with the value on each side. */
type Difference = readonly [path: string, left: unknown, right: unknown];

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The first path at which two decoded JSON values differ, with both values, or
 * undefined. Objects are walked by sorted key, arrays by index; a key missing
 * on one side, an array of another length, or a leaf that differs, is the
 * difference.
 */
function firstDifference(left: unknown, right: unknown, path = ""): Difference | undefined {
  if (isObject(left) && isObject(right)) {
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      const here = path === "" ? key : `${path}.${key}`;
      if (!(key in left)) {
        return [here, "<missing>", right[key]];
      }
      if (!(key in right)) {
        return [here, left[key], "<missing>"];
      }
      const found = firstDifference(left[key], right[key], here);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return [path || "<root>", `list of ${left.length}`, `list of ${right.length}`];
    }
    for (let index = 0; index < left.length; index++) {
      const found = firstDifference(left[index], right[index], `${path}[${index}]`);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  if (left !== right) {
    return [path || "<root>", left, right];
  }
  return undefined;
}

/** A record without the keys that belong to printing. */
function withoutPrinting(record: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !PRINTING_KEYS.includes(key)));
}

/** Throws naming the fixture and the first path where the two records differ, ignoring the printing keys. */
function assertSameRecord(name: string, go: JsonObject, node: JsonObject): void {
  const found = firstDifference(withoutPrinting(go), withoutPrinting(node));
  if (found !== undefined) {
    const [path, left, right] = found;
    assert.fail(`fixture ${name}: the records differ at ${path}: go=${JSON.stringify(left)} node=${JSON.stringify(right)}`);
  }
}

const runProgram = promisify(execFile);

/** Runs one parity program, failing with its output when it does not exit cleanly. */
async function runSide(side: string, command: string, args: string[]): Promise<void> {
  try {
    await runProgram(command, args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    assert.fail(`the ${side} parity program failed with status ${String(failure.code)}\ncommand: ${command} ${args.join(" ")}\nstdout:\n${String(failure.stdout)}\nstderr:\n${String(failure.stderr)}`);
  }
}

/** Runs both parity programs on a fixture and returns the two decoded records. */
async function runParity(t: TestContext, name: string, nodeFlags: string[] = []): Promise<{ go: JsonObject; node: JsonObject }> {
  const fixture = join(parityFixturesDirectory(), name);
  assert.ok(existsSync(fixture), `no parity fixture named ${name} in ${parityFixturesDirectory()}`);

  const directory = testDirectory(t);
  const goOut = join(directory, "go.json");
  const nodeOut = join(directory, "node.json");

  await runSide("go", pluginPath(PARITY_PROGRAM), ["-fixture", fixture, "-plugins", PLUGIN_DIRECTORY, "-out", goOut]);
  await runSide("node", process.execPath, [RUN_NODE, "--fixture", fixture, "--plugins", PLUGIN_DIRECTORY, "--out", nodeOut, ...nodeFlags]);

  return {
    go: JSON.parse(readFileSync(goOut, "utf8")) as JsonObject,
    node: JSON.parse(readFileSync(nodeOut, "utf8")) as JsonObject,
  };
}

// -- firstDifference ----------------------------------------------------------

test("firstDifference finds nothing between equal values", () => {
  assert.equal(firstDifference({ a: [1, { b: "x" }], c: null }, { c: null, a: [1, { b: "x" }] }), undefined);
});

test("firstDifference names a leaf that differs by its path", () => {
  assert.deepEqual(firstDifference({ a: { b: 1 } }, { a: { b: 2 } }), ["a.b", 1, 2]);
});

test("firstDifference names an index in a list", () => {
  assert.deepEqual(firstDifference({ a: [1, { b: "x" }] }, { a: [1, { b: "y" }] }), ["a[1].b", "x", "y"]);
});

test("firstDifference names a key missing on the right", () => {
  assert.deepEqual(firstDifference({ a: 1, b: 2 }, { a: 1 }), ["b", 2, "<missing>"]);
});

test("firstDifference names a key missing on the left", () => {
  assert.deepEqual(firstDifference({ a: 1 }, { a: 1, b: 2 }), ["b", "<missing>", 2]);
});

test("firstDifference walks keys in sorted order", () => {
  assert.deepEqual(firstDifference({ b: 1, a: 1 }, { b: 2, a: 2 }), ["a", 1, 2]);
});

test("firstDifference names a list of another length", () => {
  assert.deepEqual(firstDifference({ a: [1, 2] }, { a: [1] }), ["a", "list of 2", "list of 1"]);
});

test("firstDifference never takes a bool for a number", () => {
  assert.deepEqual(firstDifference({ a: true }, { a: 1 }), ["a", true, 1]);
});

test("firstDifference tells null from a missing key", () => {
  assert.deepEqual(firstDifference({ a: null }, {}), ["a", null, "<missing>"]);
});

test("firstDifference tells a list from an object", () => {
  assert.deepEqual(firstDifference({ a: [] }, { a: {} }), ["a", [], {}]);
});

test("firstDifference names the root when the values themselves differ", () => {
  assert.deepEqual(firstDifference(1, 2), ["<root>", 1, 2]);
});

test("firstDifference names the root for lists of another length at the top", () => {
  assert.deepEqual(firstDifference([1], []), ["<root>", "list of 1", "list of 0"]);
});

// -- the failure message ------------------------------------------------------

test("a difference fails naming the fixture and the first path", () => {
  assert.throws(() => assertSameRecord("basic_types", { entities: [{ port: 8080 }] }, { entities: [{ port: 9090 }] }), {
    message: "fixture basic_types: the records differ at entities[0].port: go=8080 node=9090",
  });
});

test("a key only Go has fails naming the fixture and the key", () => {
  assert.throws(() => assertSameRecord("outputs", { outputs: { "output.region": "eu" } }, { outputs: {} }), {
    message: 'fixture outputs: the records differ at outputs.output.region: go="eu" node="<missing>"',
  });
});

test("records equal apart from the printing keys pass", () => {
  const go = { apply: { ok: true }, printed_validate: "", printed_apply: "", printed_entities: {}, printed_diff_before: "", printed_diff_changed: "", log: [], pretty_log: null };

  assertSameRecord("basic_types", go, { apply: { ok: true } });
});

test("a difference beside the printing keys still fails", () => {
  assert.throws(() => assertSameRecord("basic_types", { apply: { ok: true }, log: [] }, { apply: { ok: false } }), {
    message: "fixture basic_types: the records differ at apply.ok: go=true node=false",
  });
});

// -- one fixture each ---------------------------------------------------------

test("parity basic_types", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "basic_types");

  assertSameRecord("basic_types", go, node);
});

test("parity annotations", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "annotations");

  assertSameRecord("annotations", go, node);
});

test("parity functions", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "functions");

  assertSameRecord("functions", go, node);
});

test("parity variables", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "variables");

  assertSameRecord("variables", go, node);
});

test("parity outputs", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "outputs");

  assertSameRecord("outputs", go, node);
});

test("parity plugin_entities", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "plugin_entities");

  assertSameRecord("plugin_entities", go, node);
});

test("parity invalid", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "invalid");

  assertSameRecord("invalid", go, node);
});

test("parity singletons", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "singletons");

  assertSameRecord("singletons", go, node);
});

test("parity encode", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "encode");

  assertSameRecord("encode", go, node);
});

test("parity unsupported_block", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "unsupported_block");

  assertSameRecord("unsupported_block", go, node);
});

// -- the encode section is not vacuous ----------------------------------------

test("the encode record holds sixteen texts for the looked-up, saved and hand-built forms", { skip: needsPrograms }, async (t) => {
  const { node } = await runParity(t, "encode");

  const store = (node.encode as Record<string, Record<string, Record<string, unknown>>>)["store.postgres.main"];

  assert.equal(Object.keys(store?.looked_up ?? {}).length, 16);
  assert.equal(Object.keys(store?.saved ?? {}).length, 16);
  assert.equal(Object.keys(store?.hand_built ?? {}).length, 16);
  assert.equal(store?.hand_built?.reveal, store?.looked_up?.reveal);
  assert.match(String(store?.looked_up?.none), /^store "postgres" "main" \{\n/);
  assert.match(String(store?.hand_built?.reveal), /password\s*=\s*"s3cret"/);
});

// -- a lookup through a registered class encodes as a generic one does --------

test("parity basic_types with typed lookups", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "basic_types", ["--typed-lookups"]);

  assertSameRecord("basic_types", go, node);
});

test("parity annotations with typed lookups", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "annotations", ["--typed-lookups"]);

  assertSameRecord("annotations", go, node);
});

test("parity functions with typed lookups", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "functions", ["--typed-lookups"]);

  assertSameRecord("functions", go, node);
});

test("parity variables with typed lookups", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "variables", ["--typed-lookups"]);

  assertSameRecord("variables", go, node);
});

test("parity outputs with typed lookups", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "outputs", ["--typed-lookups"]);

  assertSameRecord("outputs", go, node);
});

test("parity singletons with typed lookups", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "singletons", ["--typed-lookups"]);

  assertSameRecord("singletons", go, node);
});

test("parity encode with typed lookups", { skip: needsPrograms }, async (t) => {
  const { go, node } = await runParity(t, "encode", ["--typed-lookups"]);

  assertSameRecord("encode", go, node);
});
