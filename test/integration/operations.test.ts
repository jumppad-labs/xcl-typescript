/**
 * What the engine reports reaches a program as typed errors, and what the
 * package reports about the engine itself names what is wrong.
 *
 * The lookups run in this process against the real engine with the slow fixture
 * plugin. The tests about the engine's standard error, a missing engine and an
 * engine of another version run a fresh Node process, so the engine they start
 * belongs to that process alone.
 */

import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ConfigError, createConfig, EngineNotFoundError, LocalRegistry, NotFoundError, NotUniqueError, XclError } from "../../src/index.js";
import { isolateHome, missingEngine, missingPlugin, pluginPath, ROOT, SLOW_PLUGIN, testDirectory, writeConfig } from "../helpers/engine.js";
import { missingBuild, runScenario, SDK_MODULE, TRANSPORT_MODULE } from "../helpers/script.js";

const needsEngine = missingEngine() || missingBuild();
const needsPlugin = needsEngine || missingPlugin(SLOW_PLUGIN);
const posixOnly = process.platform === "win32" ? "the shim is a POSIX shell script" : false;
isolateHome();

/** A registry providing `resource "slow"`. */
function slowRegistry(): LocalRegistry {
  const registry = new LocalRegistry();
  registry.registerExternalPlugin(pluginPath(SLOW_PLUGIN));
  return registry;
}

test("a missing address throws NotFoundError", { skip: needsPlugin }, async (t) => {
  const directory = testDirectory(t);
  const configPath = writeConfig(
    directory,
    "main.xcl",
    `resource "slow" "one" {
  delay_ms = 1
}
`,
  );

  await using config = await createConfig({ registries: [slowRegistry()], statePath: join(directory, "state") });
  await config.apply(configPath);
  const error = await config.find("resource.slow.absent").then(
    () => undefined,
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof NotFoundError, `the error was: ${String(error)}`);
  assert.ok(error instanceof XclError);
  assert.equal(error.code, "not_found");
  assert.equal(error.details.address, "resource.slow.absent");
});

test("more than one match throws NotUniqueError", { skip: needsPlugin }, async (t) => {
  const directory = testDirectory(t);
  const configPath = writeConfig(
    directory,
    "main.xcl",
    `resource "slow" "one" {
  delay_ms = 1
}

resource "slow" "two" {
  delay_ms = 1
}
`,
  );

  await using config = await createConfig({ registries: [slowRegistry()], statePath: join(directory, "state") });
  await config.apply(configPath);
  const error = await config.findOne("resource", "slow").then(
    () => undefined,
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof NotUniqueError, `the error was: ${String(error)}`);
  assert.ok(error instanceof XclError);
  assert.equal(error.code, "not_unique");
  assert.equal(error.details.count, "2");
});

test("invalid configuration throws ConfigError listing each problem with its file and line", { skip: needsPlugin }, async (t) => {
  const directory = testDirectory(t);
  // the two arguments the block does not declare are on lines 2 and 3
  const configPath = writeConfig(
    directory,
    "main.xcl",
    `resource "slow" "one" {
  bogus_one = 1
  bogus_two = 2
  delay_ms  = 1
}
`,
  );

  await using config = await createConfig({ registries: [slowRegistry()], statePath: join(directory, "state") });
  const error = await config.validate(configPath).then(
    () => undefined,
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof ConfigError, `the error was: ${String(error)}`);
  assert.ok(error instanceof XclError);
  assert.equal(error.code, "config");

  const problems = [...error.problems].sort((left, right) => left.line - right.line);
  assert.equal(problems.length, 2, JSON.stringify(error.problems));

  const first = problems[0];
  assert.ok(first !== undefined);
  assert.equal(first.file, configPath);
  assert.equal(first.line, 2);
  assert.equal(first.summary, "Unsupported argument");
  assert.equal(first.entity, "resource.slow.one");
  assert.equal(first.field, "bogus_one");

  const second = problems[1];
  assert.ok(second !== undefined);
  assert.equal(second.file, configPath);
  assert.equal(second.line, 3);
  assert.equal(second.summary, "Unsupported argument");
  assert.equal(second.entity, "resource.slow.one");
  assert.equal(second.field, "bogus_two");
});

test("the engine's standard error reaches the host's", { skip: needsEngine }, async (t) => {
  // a frame the engine refuses is the one thing that makes it write to its
  // standard error: a length larger than it accepts is a framing error it
  // reports before exiting 1, and the package hands the engine the host's
  // standard error unchanged
  const source = `
import { spawn } from "node:child_process";
import { SubprocessTransport } from ${JSON.stringify(TRANSPORT_MODULE)};

let child;
const transport = new SubprocessTransport({
  launcher: (program, args, options) => {
    child = spawn(program, args, options);
    return child;
  },
});
await transport.call(0n, "GetVersion", new Uint8Array());
child.ref();
const closed = new Promise((resolve) => child.once("close", resolve));
child.stdin.write(Buffer.from([0xff, 0xff, 0xff, 0xff]));
console.log("code:" + (await closed));
`;

  const script = await runScenario(source, testDirectory(t));

  assert.equal(script.exitCode, 0, script.stderr);
  assert.deepEqual(script.values("code:"), ["1"], script.stderr);
  assert.ok(script.stderr.includes("xcl-core:"), `stderr was: ${script.stderr}`);
});

test("a missing engine is named by EngineNotFoundError", { skip: needsEngine }, async (t) => {
  const directory = testDirectory(t);
  const engine = join(directory, "no-such-engine");
  const source = `
import { createConfig, EngineNotFoundError } from ${JSON.stringify(SDK_MODULE)};

try {
  await createConfig();
  console.log("outcome:created");
} catch (error) {
  console.log("outcome:" + error.constructor.name);
  console.log("instance:" + (error instanceof EngineNotFoundError));
  console.log("message:" + error.message);
}
`;

  const script = await runScenario(source, directory, { XCL_CORE_PATH: engine });

  assert.equal(script.exitCode, 0, script.stderr);
  assert.deepEqual(script.values("outcome:"), ["EngineNotFoundError"], script.stderr);
  assert.deepEqual(script.values("instance:"), ["true"]);
  const message = script.values("message:")[0];
  assert.ok(message !== undefined, script.stderr);
  assert.ok(message.includes(engine), message);
  assert.ok(message.includes("XCL_CORE_PATH"), message);
});

test("an engine of a different version is refused naming both", { skip: needsEngine || posixOnly }, async (t) => {
  const directory = testDirectory(t);
  // the real engine cannot be made to report another version without rebuilding
  // it, so a shim runs the frame-speaking fake engine of the unit tests, which
  // the real client and transport talk to the same way, reporting v9.9.9
  const fakeEngine = join(ROOT, "build", "test", "test", "helpers", "fake-engine.js");
  const shim = writeConfig(directory, "other-engine", `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeEngine)} "$@"\n`);
  chmodSync(shim, 0o755);
  const source = `
import { createConfig, EngineVersionError } from ${JSON.stringify(SDK_MODULE)};

try {
  await createConfig();
  console.log("outcome:accepted");
} catch (error) {
  console.log("outcome:" + error.constructor.name);
  console.log("instance:" + (error instanceof EngineVersionError));
  console.log("expected:" + error.expected);
  console.log("engine:" + error.engine);
  console.log("message:" + error.message);
}
`;

  const script = await runScenario(source, directory, { XCL_CORE_PATH: shim, FAKE_VERSION: "v9.9.9" });

  assert.equal(script.exitCode, 0, script.stderr);
  assert.deepEqual(script.values("outcome:"), ["EngineVersionError"], script.stderr);
  assert.deepEqual(script.values("instance:"), ["true"]);
  assert.deepEqual(script.values("expected:"), ["v0.0.0-dev"]);
  assert.deepEqual(script.values("engine:"), ["v9.9.9"]);
  const message = script.values("message:")[0];
  assert.ok(message !== undefined, script.stderr);
  assert.ok(message.includes("v9.9.9"), message);
  assert.ok(message.includes("v0.0.0-dev"), message);
});
