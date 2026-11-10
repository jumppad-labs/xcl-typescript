/**
 * The engine program's life beside the host process, against the real `xcl-core`.
 *
 * Every test here depends on process state, so it runs its scenario in a fresh
 * Node process and the engine it watches belongs to that process alone. A
 * scenario prints what it observes as `key:value` lines, the engine's process
 * id through `sharedTransport`, and the test reads them back. Every wait is
 * bounded, and every process a test starts is ended before it returns.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { missingEngine, missingPlugin, pluginPath, RECORDING_PLUGIN, SLOW_PLUGIN, testDirectory, writeConfig } from "../helpers/engine.js";
import { ENGINE_GONE_TIMEOUT_MS, endProcess, missingBuild, processAlive, runScenario, Script, SDK_MODULE, TRANSPORT_MODULE, waitUntilGone } from "../helpers/script.js";

const needsEngine = missingEngine() || missingBuild();
const needsPlugins = needsEngine || missingPlugin(SLOW_PLUGIN) || missingPlugin(RECORDING_PLUGIN);
const posixOnly = process.platform === "win32" ? "POSIX signals are not available on Windows" : false;

const IMPORTS = `
import { createConfig, LocalRegistry, EngineExitedError } from ${JSON.stringify(SDK_MODULE)};
import { sharedTransport } from ${JSON.stringify(TRANSPORT_MODULE)};
`;

// -- one engine per process ---------------------------------------------------

const SHARED_ENGINE = `${IMPORTS}
import { execFileSync } from "node:child_process";

const configs = [];
for (let index = 0; index < 3; index += 1) {
  configs.push(await createConfig());
  console.log("pid:" + sharedTransport().pid);
}

// the engine programs among this process's children
let cores = 0;
if (process.platform !== "win32") {
  const listing = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" });
  for (const line of listing.split("\\n")) {
    const [pid, parent, command] = line.trim().split(/\\s+/);
    if (Number(parent) === process.pid && command !== undefined && command.endsWith("xcl-core")) {
      cores += 1;
    }
  }
  console.log("cores:" + cores);
} else {
  console.log("cores:unknown");
}

for (const config of configs) {
  await config.close();
}
console.log("closed:yes");

await new Promise((resolve) => process.stdin.once("end", resolve).resume());
`;

test("three configurations share one engine and closing the last leaves none running", { skip: needsEngine }, async (t) => {
  const script = new Script(SHARED_ENGINE, testDirectory(t));
  t.after(() => script.close());

  const pids = [await script.expect("pid:"), await script.expect("pid:"), await script.expect("pid:")];
  const cores = await script.expect("cores:");
  assert.equal(new Set(pids).size, 1, `the pids were: ${pids.join(", ")}`);
  if (cores !== "unknown") {
    assert.equal(cores, "1");
  }

  await script.expect("closed:");
  const pid = Number(pids[0]);
  try {
    assert.ok(await waitUntilGone(pid), `the engine ${pid} was still running ${ENGINE_GONE_TIMEOUT_MS}ms after its last configuration closed`);
    assert.equal(script.exitCode, null, "the host should still be running while the engine stops");

    script.process.stdin?.end();
    assert.equal(await script.wait(), 0, script.stderr);
  } finally {
    endProcess(pid);
  }
});

// -- a host that never closes --------------------------------------------------

const EXIT_WITHOUT_CLOSING = `${IMPORTS}
await createConfig();
console.log("pid:" + sharedTransport().pid);
`;

test("a script that never calls close still exits and leaves no engine running", { skip: needsEngine }, async (t) => {
  const script = await runScenario(EXIT_WITHOUT_CLOSING, testDirectory(t));
  const pid = Number(script.values("pid:")[0]);
  t.after(() => {
    endProcess(pid);
  });

  assert.equal(script.exitCode, 0, script.stderr);
  assert.ok(await waitUntilGone(pid), `the engine ${pid} was still running ${ENGINE_GONE_TIMEOUT_MS}ms after its host exited`);
});

// -- a host that is killed ------------------------------------------------------

const WAIT_WITH_ENGINE = `${IMPORTS}
await createConfig();
console.log("pid:" + sharedTransport().pid);
await new Promise((resolve) => setTimeout(resolve, 60_000));
`;

test("killing the host leaves no engine running within five seconds", { skip: needsEngine }, async (t) => {
  const script = new Script(WAIT_WITH_ENGINE, testDirectory(t));
  t.after(() => script.close());

  const pid = Number(await script.expect("pid:"));
  t.after(() => {
    endProcess(pid);
  });
  assert.ok(processAlive(pid), "the engine should be running before its host is killed");

  script.process.kill("SIGKILL");
  await script.wait();

  assert.ok(await waitUntilGone(pid), `the engine ${pid} was still running ${ENGINE_GONE_TIMEOUT_MS}ms after its host was killed`);
});

// -- the engine dying under the host --------------------------------------------

/** The scenario: starts an apply held open by the slow plugin, kills the engine with SIGKILL while it runs, then starts over. */
function killEngineMidApply(directory: string): string {
  const log = join(directory, "recording.jsonl");
  const slow = writeConfig(
    directory,
    "slow.xcl",
    `resource "recording" "marker" {
  log = ${JSON.stringify(log)}
}

resource "slow" "hold" {
  delay_ms   = 30000
  depends_on = ["resource.recording.marker"]
}
`,
  );
  const again = writeConfig(
    join(directory, "again"),
    "main.xcl",
    `resource "slow" "again" {
  delay_ms = 1
}
`,
  );

  return `${IMPORTS}
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const registry = new LocalRegistry();
registry.registerExternalPlugin(${JSON.stringify(pluginPath(SLOW_PLUGIN))});
registry.registerExternalPlugin(${JSON.stringify(pluginPath(RECORDING_PLUGIN))});

const config = await createConfig({ registries: [registry], statePath: ${JSON.stringify(join(directory, "state"))} });
const pid = sharedTransport().pid;
console.log("pid:" + pid);

const outcome = {};
const applying = config.apply(${JSON.stringify(slow)}).then(
  () => { outcome.result = "completed"; },
  (error) => {
    outcome.result = error.constructor.name;
    outcome.isExited = error instanceof EngineExitedError;
    outcome.signal = error.signal;
  },
);

// the recording plugin writes this before the slow resource starts, so once it
// is there the apply is running and the slow resource holds it open
const deadline = Date.now() + 30_000;
while (!(existsSync(${JSON.stringify(log)}) && readFileSync(${JSON.stringify(log)}, "utf8").includes("create"))) {
  if (Date.now() > deadline) {
    console.log("marker:timeout");
    process.exit(2);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
console.log("marker:seen");

// the plugins the engine started outlive an engine ended by SIGKILL, so they
// are listed for the test to end
const children = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
for (const line of children.split("\\n")) {
  const [child, parent] = line.trim().split(/\\s+/);
  if (Number(parent) === pid) {
    console.log("plugin:" + child);
  }
}

process.kill(pid, "SIGKILL");
await applying;
console.log("pending:no");
console.log("result:" + outcome.result);
console.log("exited:" + outcome.isExited);
console.log("signal:" + outcome.signal);
await config.close();

// the host carries on: a new configuration starts a new engine and applies
const fresh = new LocalRegistry();
fresh.registerExternalPlugin(${JSON.stringify(pluginPath(SLOW_PLUGIN))});
const replacement = await createConfig({ registries: [fresh], statePath: ${JSON.stringify(join(directory, "state-again"))} });
console.log("new-pid:" + sharedTransport().pid);
await replacement.apply(${JSON.stringify(again)});
const entity = await replacement.find("resource.slow.again");
console.log("done:" + entity.attributes.done);
await replacement.close();
console.log("finished:yes");
`;
}

/** Runs the scenario and ends every plugin process the killed engine left behind. */
async function runKillEngineMidApply(directory: string): Promise<Script> {
  const script = await runScenario(killEngineMidApply(directory), directory);
  for (const plugin of script.values("plugin:")) {
    endProcess(Number(plugin));
  }
  return script;
}

test("killing the engine mid-apply rejects with EngineExitedError carrying the signal", { skip: needsPlugins || posixOnly }, async (t) => {
  const script = await runKillEngineMidApply(testDirectory(t));

  assert.deepEqual(script.values("marker:"), ["seen"], script.stderr);
  assert.deepEqual(script.values("result:"), ["EngineExitedError"], script.stderr);
  assert.deepEqual(script.values("exited:"), ["true"], script.stderr);
  assert.deepEqual(script.values("signal:"), ["SIGKILL"], script.stderr);
});

test("the host carries on after the engine dies and a new configuration works", { skip: needsPlugins || posixOnly }, async (t) => {
  const script = await runKillEngineMidApply(testDirectory(t));

  assert.equal(script.exitCode, 0, script.stderr);
  const oldPid = script.values("pid:")[0];
  const newPid = script.values("new-pid:")[0];
  assert.ok(oldPid !== undefined && newPid !== undefined, script.stderr);
  assert.notEqual(newPid, oldPid);
  assert.deepEqual(script.values("done:"), ["true"], script.stderr);
  assert.deepEqual(script.values("finished:"), ["yes"], script.stderr);
  assert.ok(await waitUntilGone(Number(newPid)), `the replacement engine ${newPid} was still running ${ENGINE_GONE_TIMEOUT_MS}ms after its last configuration closed`);
});

// -- startup -----------------------------------------------------------------

const FIRST_CONFIG_TIMED = `${IMPORTS}
const began = performance.now();
const config = await createConfig();
const took = performance.now() - began;
await config.close();
console.log("took:" + took);
`;

test("the first configuration in a process is created within one second", { skip: needsEngine }, async (t) => {
  const script = await runScenario(FIRST_CONFIG_TIMED, testDirectory(t));

  assert.equal(script.exitCode, 0, script.stderr);
  const took = Number(script.values("took:")[0]);
  assert.ok(took < 1000, `the first createConfig took ${took}ms`);
});
