/**
 * A real configuration mistake, reported as Go reports it: printed, on the
 * console and uncaught. The uncaught tests start a fresh process with
 * `process.execPath`, so the Node version under test is the one running the
 * suite, and CI's Node 22, 24 and 26 matrix covers each.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConfigError, Config, formatError, LocalRegistry, printError } from "../../src/index.js";
import { isolateHome, missingEngine, missingPlugin, pluginPath, RECORDING_PLUGIN, ROOT, testDirectory } from "../helpers/engine.js";
import { runScenario, SDK_MODULE, missingBuild } from "../helpers/script.js";

const needsPlugin = missingEngine() || missingPlugin(RECORDING_PLUGIN);
const needsBuild = needsPlugin || missingBuild();
isolateHome();

const FIXTURE = join(ROOT, "test", "integration", "fixtures", "unsupported-block", "main.xcl");
const SCRIPTS = fileURLToPath(new URL("./scripts/", import.meta.url));

/** The report Go writes for the unsupported block on line 7 of the fixture. */
const GO_REPORT = `Error: Unsupported block type

  on ${FIXTURE} line 7, in resource.recording.two, field nope[0]:
     5 | 
     6 | resource "recording" "two" {
     7 |   nope {
     8 |     a = 1
     9 |   }

Blocks of type "nope" are not expected here.

`;

async function rejected(t: TestContext): Promise<ConfigError> {
  const local = new LocalRegistry();
  local.registerExternalPlugin(pluginPath(RECORDING_PLUGIN));
  const config: Config = await new Config({ registries: [local], statePath: join(testDirectory(t), "state") }).setup();
  t.after(() => config.close());
  const error = await config.apply(FIXTURE).catch((caught: unknown) => caught);
  assert.ok(error instanceof ConfigError);
  return error;
}

test("the report for an unsupported block on line 7 equals Go's", { skip: needsPlugin }, async (t) => {
  assert.equal(formatError(await rejected(t)), GO_REPORT);
});

test("printing the error writes Go's report", { skip: needsPlugin }, async (t) => {
  const error = await rejected(t);
  let text = "";
  printError(error, { out: { write: (chunk) => (text += chunk) } });
  assert.equal(text, GO_REPORT);
});

test("the error's message is one line", { skip: needsPlugin }, async (t) => {
  assert.doesNotMatch((await rejected(t)).message, /\n/);
});

/** Runs a compiled script that holds no printing code in a fresh process, for the fixture. */
async function runScript(t: TestContext, name: string): Promise<{ stderr: string; exitCode: number | null }> {
  const directory = testDirectory(t);
  const url = pathToFileURL(join(SCRIPTS, `${name}.js`)).href;
  const args = [FIXTURE, pluginPath(RECORDING_PLUGIN), join(directory, "state")].join("\n");
  const script = await runScenario(`await import(${JSON.stringify(url)});`, directory, { XCL_TEST_ARGS: args });
  // Node prints an uncaught error from native code, which on Windows writes
  // CRLF line endings; console.error writes through a stream and keeps LF
  return { stderr: script.stderr.replace(/\r\n/g, "\n"), exitCode: script.exitCode };
}

test("an uncaught error writes the report to standard error and exits with a failure status", { skip: needsBuild }, async (t) => {
  const { stderr, exitCode } = await runScript(t, "uncaught-throw");
  assert.ok(stderr.includes(GO_REPORT.trimEnd()), stderr);
  assert.equal(exitCode, 1);
});

test("a rejected top-level await writes the report to standard error and exits with a failure status", { skip: needsBuild }, async (t) => {
  const { stderr, exitCode } = await runScript(t, "uncaught-await");
  assert.ok(stderr.includes(GO_REPORT.trimEnd()), stderr);
  assert.equal(exitCode, 1);
});

test("an uncaught error's report holds no colour codes", { skip: needsBuild }, async (t) => {
  const { stderr } = await runScript(t, "uncaught-throw");
  assert.doesNotMatch(stderr, /\x1b\[/);
});

test("console.error writes the report in a fresh process", { skip: needsBuild }, async (t) => {
  const directory = testDirectory(t);
  const source = `import { Config, LocalRegistry } from ${JSON.stringify(SDK_MODULE)};
const local = new LocalRegistry();
local.registerExternalPlugin(${JSON.stringify(pluginPath(RECORDING_PLUGIN))});
const config = await new Config({ registries: [local], statePath: ${JSON.stringify(join(directory, "state"))} }).setup();
try {
  await config.validate(${JSON.stringify(FIXTURE)});
} catch (error) {
  console.error(error);
}
await config.close();
`;
  const script = await runScenario(source, directory);
  assert.ok(script.stderr.includes(GO_REPORT.trimEnd()), script.stderr);
  assert.equal(script.exitCode, 0);
});
