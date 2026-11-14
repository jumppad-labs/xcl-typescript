/** The event loop keeps serving other work while a slow operation runs. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isolateHome, missingEngine, missingPlugin, pluginPath, SLOW_PLUGIN, testDirectory, writeConfig } from "../helpers/engine.js";
import { missingBuild, runScenario, SDK_MODULE } from "../helpers/script.js";

const needsPlugin = missingEngine() || missingBuild() || missingPlugin(SLOW_PLUGIN);
isolateHome();

/** How long the slow resource takes to create, in milliseconds. */
const APPLY_MS = 2000;

const SLOW = `resource "slow" "one" {
  delay_ms = ${APPLY_MS}
}
`;

/**
 * Runs a monitored timer and an HTTP server answering requests, first for as
 * long as the apply takes with nothing else running, then beside a slow apply,
 * with the pretty logger on when asked.
 *
 * The first run is the baseline: how late a timer fires on this machine
 * depends on the machine (coarse timers and busy runners on macOS add tens of
 * milliseconds), so a fixed limit would judge the machine rather than the
 * apply. What the apply adds to the baseline is what the SDK is responsible for.
 */
function scenario(path: string, state: string, prettyLog = false): string {
  return `import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Config, EventDataLevel, LocalRegistry, prettylog } from ${JSON.stringify(SDK_MODULE)};

const server = createServer((request, response) => {
  response.end("ok");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + server.address().port + "/";

const local = new LocalRegistry();
local.registerExternalPlugin(${JSON.stringify(pluginPath(SLOW_PLUGIN))});
const config = await new Config({ registries: [local], statePath: ${JSON.stringify(state)}${prettyLog ? ", onEvent: prettylog.handler(), eventData: EventDataLevel.Processed" : ""} }).setup();

async function request(settled) {
  let answered = 0;
  let failed = 0;
  while (!settled()) {
    const response = await fetch(url).catch(() => undefined);
    if (response?.status === 200) {
      answered += 1;
    } else {
      failed += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { answered, failed };
}

const monitor = monitorEventLoopDelay({ resolution: 10 });

monitor.enable();
let idle = false;
const idling = new Promise((resolve) => setTimeout(resolve, ${APPLY_MS})).then(() => {
  idle = true;
});
await request(() => idle);
await idling;
monitor.disable();
const baseline = monitor.percentile(99) / 1e6;
monitor.reset();

monitor.enable();
let settled = false;
const applying = config.apply(${JSON.stringify(path)}).finally(() => {
  settled = true;
});
const { answered, failed } = await request(() => settled);
await applying;
monitor.disable();

console.log("baseline-p99:" + baseline);
console.log("p99:" + monitor.percentile(99) / 1e6);
console.log("answered:" + answered);
console.log("failed:" + failed);
await config.close();
server.close();
`;
}

/** The 99th-percentile delays the scenario printed, with nothing running and during the apply, in milliseconds. */
function delays(script: { values(prefix: string): string[] }): { baseline: number; p99: number } {
  const baseline = Number(script.values("baseline-p99:")[0]);
  const p99 = Number(script.values("p99:")[0]);
  assert.ok(baseline > 0, `the monitor recorded no delay with nothing running: ${String(script.values("baseline-p99:")[0])}`);
  assert.ok(p99 > 0, `the monitor recorded no delay during the apply: ${String(script.values("p99:")[0])}`);
  return { baseline, p99 };
}

test("a slow apply adds less than 50 ms to a timer's 99th-percentile delay", { skip: needsPlugin }, async (t) => {
  const directory = testDirectory(t);
  const script = await runScenario(scenario(writeConfig(directory, "main.xcl", SLOW), `${directory}/state`), directory);

  assert.equal(script.exitCode, 0, script.stderr);
  const { baseline, p99 } = delays(script);
  assert.ok(p99 - baseline < 50, `the event loop's 99th-percentile delay was ${p99} ms during the apply, against ${baseline} ms with nothing running`);
});

test("an HTTP server in the same process answers requests throughout a slow apply", { skip: needsPlugin }, async (t) => {
  const directory = testDirectory(t);
  const script = await runScenario(scenario(writeConfig(directory, "main.xcl", SLOW), `${directory}/state`), directory);

  assert.equal(script.exitCode, 0, script.stderr);
  assert.equal(Number(script.values("failed:")[0]), 0);
  assert.ok(Number(script.values("answered:")[0]) >= 25, `only ${String(script.values("answered:")[0])} requests were answered during a 2 s apply`);
});

test("with the pretty logger on, a slow apply adds less than 50 ms to a timer's 99th-percentile delay", { skip: needsPlugin }, async (t) => {
  const directory = testDirectory(t);
  const script = await runScenario(scenario(writeConfig(directory, "main.xcl", SLOW), `${directory}/state`, true), directory);

  assert.equal(script.exitCode, 0, script.stderr);
  assert.ok(script.stderr.includes("create success"), script.stderr);
  const { baseline, p99 } = delays(script);
  assert.ok(p99 - baseline < 50, `the event loop's 99th-percentile delay was ${p99} ms during the apply, against ${baseline} ms with nothing running`);
});
