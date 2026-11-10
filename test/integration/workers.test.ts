/** Configurations in worker threads, cluster workers and child-process workers. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isolateHome, missingEngine, testDirectory, writeConfig } from "../helpers/engine.js";
import { missingBuild, runScenario, SDK_MODULE } from "../helpers/script.js";

const needsEngine = missingEngine() || missingBuild();
isolateHome();

const TEXT = `app "web" {
  image = "nginx"
}
`;

/** Applies the configuration at `path` and prints what it read back. */
function applyProgram(path: string, state: string): string {
  return `const { Attribute, createConfig, Entity, LocalRegistry, Meta } = await import(${JSON.stringify(SDK_MODULE)});
class App {
  meta;
  image;
}
Meta()(App.prototype, "meta");
Attribute(String)(App.prototype, "image");
Entity("app")(App);
const local = new LocalRegistry();
local.register(App);
const config = await createConfig({ registries: [local], statePath: ${JSON.stringify(state)} });
await config.apply(${JSON.stringify(path)});
const web = await config.find(App, "app.web");
await config.close();
`;
}

test("a configuration created inside a worker thread applies", { skip: needsEngine }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", TEXT);
  const worker = `import { parentPort } from "node:worker_threads";
${applyProgram(path, `${directory}/state-worker`)}
parentPort.postMessage(web.image);
`;

  const script = await runScenario(
    `import { Worker } from "node:worker_threads";
import { writeFileSync } from "node:fs";
writeFileSync("worker.mjs", ${JSON.stringify(worker)});
const image = await new Promise((resolve, reject) => {
  const thread = new Worker(new URL("worker.mjs", import.meta.url));
  thread.once("message", resolve);
  thread.once("error", reject);
});
console.log("image:" + image);
`,
    directory,
  );

  assert.equal(script.exitCode, 0, script.stderr);
  assert.equal(script.values("image:")[0], "nginx");
});

test("a configuration created inside a cluster worker applies", { skip: needsEngine }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", TEXT);

  const script = await runScenario(
    `import cluster from "node:cluster";
if (cluster.isPrimary) {
  const worker = cluster.fork();
  const image = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  console.log("image:" + image);
  worker.kill();
} else {
  ${applyProgram(path, `${directory}/state-cluster`)}
  process.send(web.image);
}
`,
    directory,
  );

  assert.equal(script.exitCode, 0, script.stderr);
  assert.equal(script.values("image:")[0], "nginx");
});

test("a configuration created inside a child-process worker applies", { skip: needsEngine }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", TEXT);

  const script = await runScenario(
    `import { fork } from "node:child_process";
if (process.argv[2] === "child") {
  ${applyProgram(path, `${directory}/state-child`)}
  process.send(web.image);
} else {
  const child = fork(process.argv[1], ["child"]);
  const image = await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
  });
  console.log("image:" + image);
  child.kill();
}
`,
    directory,
  );

  assert.equal(script.exitCode, 0, script.stderr);
  assert.equal(script.values("image:")[0], "nginx");
});
