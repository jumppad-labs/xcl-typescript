/** The Node parity runner replaces the run's directories and renders errors the way the Go program does. */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ConfigError, Diff, InternalError, NotFoundError } from "../../src/index.js";
import { testDirectory } from "../helpers/engine.js";
import { encodeCombinations, goSprintKey, Normaliser } from "./run.js";

function unixNormaliser(): Normaliser {
  return new Normaliser({ tmp: "/tmp/run", fixture: "/work/fixture" });
}

function windowsNormaliser(): Normaliser {
  return new Normaliser({ tmp: "C:\\Temp\\xcl-parity-1", fixture: "D:\\fixtures\\plugin_entities" });
}

test("text replaces the temporary directory escaped in configuration text", () => {
  const text = windowsNormaliser().text('log = "C:\\\\Temp\\\\xcl-parity-1/recording.log"');

  assert.equal(text, 'log = "<tmp>/recording.log"');
});

test("text replaces the fixture directory escaped in configuration text", () => {
  const text = windowsNormaliser().text('source = "D:\\\\fixtures\\\\plugin_entities\\\\main.xcl"');

  assert.equal(text, 'source = "<fixture>\\\\main.xcl"');
});

test("text replaces the temporary directory as written", () => {
  const text = windowsNormaliser().text("C:\\Temp\\xcl-parity-1\\state");

  assert.equal(text, "<tmp>\\state");
});

test("text replaces both directories wherever they appear", () => {
  const text = unixNormaliser().text("read /work/fixture/main.xcl and /tmp/run/state and /tmp/run/home");

  assert.equal(text, "read <fixture>/main.xcl and <tmp>/state and <tmp>/home");
});

test("text leaves a string naming neither directory alone", () => {
  assert.equal(unixNormaliser().text("nginx:1.27"), "nginx:1.27");
});

test("path replaces the fixture directory", () => {
  assert.equal(unixNormaliser().path("/work/fixture/main.xcl"), "<fixture>/main.xcl");
});

test("walk replaces paths in every string of a nested value", () => {
  const walked = unixNormaliser().walk({ a: "/tmp/run/x", b: ["/work/fixture", 1, true, null], c: { d: "/tmp/run" } });

  assert.deepEqual(walked, { a: "<tmp>/x", b: ["<fixture>", 1, true, null], c: { d: "<tmp>" } });
});

test("value passes a value through JSON and replaces paths", () => {
  const rendered = unixNormaliser().value({ path: "/tmp/run/x", dropped: undefined, count: 2 });

  assert.deepEqual(rendered, { path: "<tmp>/x", count: 2 });
});

test("value renders undefined as null, as Go renders a nil value", () => {
  assert.equal(unixNormaliser().value(undefined), null);
});

test("outcome of no error is ok", () => {
  assert.deepEqual(unixNormaliser().outcome(undefined), { ok: true });
});

test("outcome of an engine error that is no configuration problem is internal, with its message", () => {
  const outcome = unixNormaliser().outcome(new NotFoundError("nothing at /tmp/run/x"));

  assert.deepEqual(outcome, { ok: false, error: { code: "internal", message: "nothing at <tmp>/x" } });
});

test("outcome of an internal error holds its message", () => {
  const outcome = unixNormaliser().outcome(new InternalError("the plugin stopped"));

  assert.deepEqual(outcome, { ok: false, error: { code: "internal", message: "the plugin stopped" } });
});

test("outcome of a config error with no diagnostic records its code and no problems", () => {
  const outcome = unixNormaliser().outcome(new ConfigError("the configuration is invalid"));

  assert.deepEqual(outcome, { ok: false, error: { code: "config" }, problems: [] });
});

test("problem of a positioned diagnostic records its file, position, text, block and field", () => {
  const diagnostic = new ConfigError("bad", {
    details: { severity: "error", summary: "Unsupported argument", detail: "see /work/fixture/main.xcl", entity: "app.web", field: "colour", file: "/work/fixture/main.xcl", line: "7", column: "3" },
  });

  assert.deepEqual(unixNormaliser().problem(diagnostic), {
    code: "config",
    summary: "Unsupported argument",
    detail: "see <fixture>/main.xcl",
    entity: "app.web",
    field: "colour",
    file: "<fixture>/main.xcl",
    line: 7,
    column: 3,
  });
});

test("problem of a diagnostic with no position records no file, line or column", () => {
  const diagnostic = new ConfigError("bad", { details: { severity: "error", summary: "Missing", detail: "", entity: "app.web", field: "image" } });

  assert.deepEqual(unixNormaliser().problem(diagnostic), { code: "config", summary: "Missing", detail: "", entity: "app.web", field: "image" });
});

test("problem finds a diagnostic among the causes before the config error around it", () => {
  const diagnostic = new ConfigError("bad", { details: { severity: "error", summary: "Missing", detail: "", entity: "app.web", field: "image" } });
  const wrapper = new ConfigError("the configuration is invalid", { causes: [diagnostic] });

  assert.deepEqual(unixNormaliser().problem(wrapper), { code: "config", summary: "Missing", detail: "", entity: "app.web", field: "image" });
});

test("outcome sorts a config error's problems by fmt.Sprint of each", () => {
  const later = new ConfigError("b", { details: { severity: "error", summary: "Zulu", detail: "", entity: "app.a", field: "" } });
  const earlier = new ConfigError("a", { details: { severity: "error", summary: "Alpha", detail: "", entity: "app.b", field: "" } });
  const error = new ConfigError("the configuration is invalid", { causes: [later, earlier] });

  const outcome = unixNormaliser().outcome(error);

  assert.deepEqual(outcome.problems, [
    { code: "config", summary: "Zulu", detail: "", entity: "app.a", field: "" },
    { code: "config", summary: "Alpha", detail: "", entity: "app.b", field: "" },
  ]);
});

test("goSprintKey writes a map as fmt.Sprint does, keys sorted", () => {
  const key = goSprintKey({ line: 7, code: "config", entity: "", ok: false, nested: { b: 1, a: [true, "x"] } });

  assert.equal(key, "map[code:config entity: line:7 nested:map[a:[true x] b:1] ok:false]");
});

test("entities are rendered and sorted by id", () => {
  const rendered = unixNormaliser().entities([{ meta: { id: "b" } }, { meta: { id: "a" }, path: "/tmp/run/a" }]);

  assert.deepEqual(rendered, [{ meta: { id: "a" }, path: "<tmp>/a" }, { meta: { id: "b" } }]);
});

test("a value with no meta id sorts first", () => {
  const rendered = unixNormaliser().entities([{ meta: { id: "a" } }, { other: true }]);

  assert.deepEqual(rendered, [{ other: true }, { meta: { id: "a" } }]);
});

test("the state of a directory with no state file is null", (t) => {
  assert.equal(unixNormaliser().state(join(testDirectory(t), "nothing")), null);
});

test("the state of a directory is its records, paths replaced, sorted by id", (t) => {
  const directory = testDirectory(t);
  writeFileSync(join(directory, "state.json"), JSON.stringify([{ meta: { id: "b" } }, { meta: { id: "a" }, file: "/work/fixture/main.xcl" }]));

  assert.deepEqual(unixNormaliser().state(directory), [{ meta: { id: "a" }, file: "<fixture>/main.xcl" }, { meta: { id: "b" } }]);
});

test("a state file holding null is no records, as Go decodes it", (t) => {
  const directory = testDirectory(t);
  writeFileSync(join(directory, "state.json"), "null");

  assert.deepEqual(unixNormaliser().state(directory), []);
});

test("a state file that is not a JSON array is recorded as such", (t) => {
  const directory = join(testDirectory(t), "state");
  mkdirSync(directory);
  writeFileSync(join(directory, "state.json"), "{}");

  assert.deepEqual(unixNormaliser().state(directory), { error: "state is not a JSON array" });
});

test("a state file that is not JSON is recorded as not a JSON array", (t) => {
  const directory = testDirectory(t);
  writeFileSync(join(directory, "state.json"), "not json");

  assert.deepEqual(unixNormaliser().state(directory), { error: "state is not a JSON array" });
});

test("encoded text has the run's paths replaced", () => {
  assert.equal(unixNormaliser().encoded('log = "/tmp/run/recording.log"\n', undefined), 'log = "<tmp>/recording.log"\n');
});

test("an encoding that failed is its outcome", () => {
  assert.deepEqual(unixNormaliser().encoded(undefined, new InternalError("no")), { ok: false, error: { code: "internal", message: "no" } });
});

test("a diff is its engine JSON, snake_case and with paths replaced", () => {
  const diff = Diff.fromJSON(new TextEncoder().encode(JSON.stringify({ summary: { create: 1 }, resources: [{ address: "app.web", replaced_dependencies: ["/tmp/run/x"] }] })));

  assert.deepEqual(unixNormaliser().diff(diff, undefined), { summary: { create: 1 }, resources: [{ address: "app.web", replaced_dependencies: ["<tmp>/x"] }] });
});

test("a diff that failed is its outcome", () => {
  assert.deepEqual(unixNormaliser().diff(undefined, new InternalError("no")), { ok: false, error: { code: "internal", message: "no" } });
});

test("there are sixteen encode combinations, named as Go names them", () => {
  const names = encodeCombinations().map(([name]) => name);

  assert.deepEqual(names, [
    "none",
    "computed",
    "empty",
    "computed+empty",
    "reveal",
    "computed+reveal",
    "empty+reveal",
    "computed+empty+reveal",
    "references",
    "computed+references",
    "empty+references",
    "computed+empty+references",
    "reveal+references",
    "computed+reveal+references",
    "empty+reveal+references",
    "computed+empty+reveal+references",
  ]);
});

test("the combination of every choice turns all four on", () => {
  const every = encodeCombinations().find(([name]) => name === "computed+empty+reveal+references");

  assert.deepEqual(every?.[1], { includeComputed: true, includeEmpty: true, revealSensitive: true, showReferences: true });
});

test("the combination of no choice turns all four off", () => {
  const none = encodeCombinations().find(([name]) => name === "none");

  assert.deepEqual(none?.[1], { includeComputed: false, includeEmpty: false, revealSensitive: false, showReferences: false });
});
