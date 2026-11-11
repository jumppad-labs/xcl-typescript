/** The event loop keeps serving other work while a slow operation runs. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isolateHome, missingEngine, missingPlugin, pluginPath, SLOW_PLUGIN, testDirectory, writeConfig } from "../helpers/engine.js";
import { missingBuild, runScenario, SDK_MODULE } from "../helpers/script.js";

const needsPlugin = missingEngine() || missingBuild() || missingPlugin(SLOW_PLUGIN);
isolateHome();

const SLOW = `resource "slow" "one" {
  delay_ms = 2000
}
`;

/** Runs a slow apply beside a monitored timer and an HTTP server answering requests, with the pretty logger on when asked. */
function scenario(path: string, state: string, prettyLog = false): string {
  return `import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createConfig, EventDataLevel, LocalRegistry, prettylog } from ${JSON.stringify(SDK_MODULE)};

const server = createServer((request, response) => {
  response.end("ok");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + server.address().port + "/";

const local = new LocalRegistry();
local.registerExternalPlugin(${JSON.stringify(pluginPath(SLOW_PLUGIN))});
const config = await createConfig({ registries: [local], statePath: ${JSON.stringify(state)}${prettyLog ? ", onEvent: prettylog.handler(), eventData: EventDataLevel.Processed" : ""} });

const monitor = monitorEventLoopDelay({ resolution: 10 });
monitor.enable();
let settled = false;
const applying = config.apply(${JSON.stringify(path)}).finally(() => {
  settled = true;
});

let answered = 0;
let failed = 0;
while (!settled) {
  const response = await fetch(url).catch(() => undefined);
  if (response?.status === 200) {
    answered += 1;
  } else {
    failed += 1;
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}
await applying;
monitor.disable();

console.log("p99:" + monitor.percentile(99) / 1e6);
console.log("answered:" + answered);
console.log("failed:" + failed);
await config.close();
server.close();
`;
}

test("a timer's 99th-percentile delay stays under 50 ms during a slow apply", { skip: needsPlugin }, async (t) => {
  const directory = testDirectory(t);
  const script = await runScenario(scenario(writeConfig(directory, "main.xcl", SLOW), `${directory}/state`), directory);

  assert.equal(script.exitCode, 0, script.stderr);
  const p99 = Number(script.values("p99:")[0]);
  assert.ok(p99 > 0, `the monitor recorded no delay: ${String(script.values("p99:")[0])}`);
  assert.ok(p99 < 50, `the event loop's 99th-percentile delay was ${p99} ms`);
});

test("an HTTP server in the same process answers requests throughout a slow apply", { skip: needsPlugin }, async (t) => {
  const directory = testDirectory(t);
  const script = await runScenario(scenario(writeConfig(directory, "main.xcl", SLOW), `${directory}/state`), directory);

  assert.equal(script.exitCode, 0, script.stderr);
  assert.equal(Number(script.values("failed:")[0]), 0);
  assert.ok(Number(script.values("answered:")[0]) >= 25, `only ${String(script.values("answered:")[0])} requests were answered during a 2 s apply`);
});

test("with the pretty logger on, a timer's 99th-percentile delay stays under 50 ms during a slow apply", { skip: needsPlugin }, async (t) => {
  const directory = testDirectory(t);
  const script = await runScenario(scenario(writeConfig(directory, "main.xcl", SLOW), `${directory}/state`, true), directory);

  assert.equal(script.exitCode, 0, script.stderr);
  assert.ok(script.stderr.includes("create success"), script.stderr);
  const p99 = Number(script.values("p99:")[0]);
  assert.ok(p99 > 0, `the monitor recorded no delay: ${String(script.values("p99:")[0])}`);
  assert.ok(p99 < 50, `the event loop's 99th-percentile delay was ${p99} ms`);
});
