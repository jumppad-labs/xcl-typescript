/**
 * Cancelling an operation in the real engine.
 *
 * The configuration puts a slow resource between two items of the test plugin,
 * in dependency order: `first`, then `gate` taking a second, then `after`.
 * The abort comes while `gate` holds the apply open, so `first` has completed
 * and `after` must never start: the plugin appends every operation to its log
 * as the operation starts, which the tests read back.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { CancelledError, Config, LocalRegistry } from "../../src/index.js";
import { isolateHome, missingEngine, missingPlugin, pluginPath, sharedDirectory, SLOW_PLUGIN, testDirectory, writeConfig } from "../helpers/engine.js";
import { installedRelease, readOperations, type ReleaseFiles } from "../helpers/plugins.js";

const skip = missingEngine() || missingPlugin(SLOW_PLUGIN);
isolateHome();
const cache = sharedDirectory();

const FIRST = "test.item.first";
const GATE = "resource.slow.gate";
const AFTER = "test.item.after";

/**
 * How long the slow resource holds the apply, in milliseconds. A cancel lets the
 * provider call already in flight finish, as providers are called with a context
 * that is never cancelled, so the gate must end well inside the two-second bound.
 */
const GATE_DELAY_MS = 1000;

/** How long the operation has to reach the gate, in milliseconds. */
const REACH_GATE_TIMEOUT_MS = 30_000;

/** How soon after the abort the apply must reject, in milliseconds. */
const CANCEL_WITHIN_MS = 2000;

function gatedConfig(log: string): string {
  const quotedLog = JSON.stringify(log);
  return `test "item" "first" {
  log   = ${quotedLog}
  value = "one"
}

resource "slow" "gate" {
  delay_ms   = ${GATE_DELAY_MS}
  depends_on = ["${FIRST}"]
}

test "item" "after" {
  log        = ${quotedLog}
  value      = "two"
  depends_on = ["${GATE}"]
}
`;
}

function registryFor(release: ReleaseFiles): LocalRegistry {
  const registry = new LocalRegistry();
  registry.registerExternalPlugin(release.binary);
  registry.registerExternalPlugin(pluginPath(SLOW_PLUGIN));
  return registry;
}

/** The addresses of the records in the state directory `state`. */
function savedAddresses(state: string): string[] {
  const records = JSON.parse(readFileSync(join(state, "state.json"), "utf8")) as { meta: { id: string } }[];
  return records.map((record) => record.meta.id);
}

interface Gated {
  config: Config;
  log: string;
  state: string;
  directory: string;
  controller: AbortController;
  /** Settles with the apply: holds the error it rejected with, or undefined when it resolved. */
  applied: Promise<unknown>;
}

/**
 * Starts the gated apply and returns once the gate's create has started, with
 * `first` complete. The event comes from the engine as `gate` is starting, and
 * the test's abort follows at once, inside the gate's delay.
 */
async function applyUpToGate(t: TestContext, release: ReleaseFiles): Promise<Gated> {
  const directory = testDirectory(t);
  const log = join(directory, "ops.jsonl");
  const state = join(directory, "state");
  const path = writeConfig(directory, "main.xcl", gatedConfig(log));

  let reachGate!: () => void;
  const atGate = new Promise<void>((resolve) => {
    reachGate = resolve;
  });
  const config = await new Config({
    registries: [registryFor(release)],
    statePath: state,
    onEvent: (event) => {
      if (event.resourceId === GATE && event.operation === "create" && event.phase === "start") {
        reachGate();
      }
    },
  }).setup();
  t.after(() => config.close());

  const controller = new AbortController();
  const applied = config.apply(path, { signal: controller.signal }).then(
    () => undefined,
    (error: unknown) => error,
  );

  let timer: NodeJS.Timeout | undefined;
  const reached = await Promise.race([
    atGate.then(() => "gate"),
    applied.then((error) => `the apply ended before reaching the gate: ${String(error)}`),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => {
        resolve(`the apply did not reach the gate within ${REACH_GATE_TIMEOUT_MS}ms`);
      }, REACH_GATE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  assert.equal(reached, "gate");

  return { config, log, state, directory, controller, applied };
}

test("aborting mid-apply rejects with CancelledError within two seconds", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const { controller, applied } = await applyUpToGate(t, release);

  const reason = new Error("the deploy was stopped");
  const began = performance.now();
  controller.abort(reason);
  const error = await applied;
  const elapsed = performance.now() - began;

  assert.ok(error instanceof CancelledError, `the apply ended with: ${String(error)}`);
  assert.equal(error.cause, reason);
  assert.ok(elapsed < CANCEL_WITHIN_MS, `the apply took ${elapsed}ms to reject after the abort`);
});

test("without an abort the item behind the gate is created", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const directory = testDirectory(t);
  const log = join(directory, "ops.jsonl");
  const path = writeConfig(directory, "main.xcl", gatedConfig(log));
  await using config = await new Config({ registries: [registryFor(release)], statePath: join(directory, "state") }).setup();

  await config.apply(path);

  assert.deepEqual(readOperations(log), [
    { operation: "create", address: FIRST },
    { operation: "create", address: AFTER },
  ]);
});

test("the entities completed before the abort are in state", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const { controller, applied, state } = await applyUpToGate(t, release);

  controller.abort();
  assert.ok((await applied) instanceof CancelledError);

  assert.ok(savedAddresses(state).includes(FIRST), `the state holds: ${savedAddresses(state).join(", ")}`);
});

test("the test plugin records no operation started after the abort", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const { controller, applied, log, config } = await applyUpToGate(t, release);
  const beforeAbort = readOperations(log);
  assert.deepEqual(beforeAbort, [{ operation: "create", address: FIRST }]);

  controller.abort();
  assert.ok((await applied) instanceof CancelledError);
  // closing ends the plugins, so nothing can still be on its way to the log
  await config.close();

  assert.deepEqual(readOperations(log), beforeAbort);
});

test("an item behind the gate is not in state after the abort", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const { controller, applied, state } = await applyUpToGate(t, release);

  controller.abort();
  assert.ok((await applied) instanceof CancelledError);

  assert.equal(savedAddresses(state).includes(AFTER), false, `the state holds: ${savedAddresses(state).join(", ")}`);
});

test("an apply that was never let start records nothing and saves nothing", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const directory = testDirectory(t);
  const log = join(directory, "ops.jsonl");
  const state = join(directory, "state");
  const path = writeConfig(directory, "main.xcl", gatedConfig(log));
  await using config = await new Config({ registries: [registryFor(release)], statePath: state }).setup();

  await assert.rejects(config.apply(path, { signal: AbortSignal.abort() }), CancelledError);

  assert.equal(existsSync(log), false);
  assert.deepEqual(savedAddresses(state), []);
});

test("the configuration applies again after a cancelled apply", { skip }, async (t) => {
  const release = await installedRelease(t, cache);
  if (release === undefined) {
    return;
  }
  const { controller, applied, config, directory, log } = await applyUpToGate(t, release);
  controller.abort();
  assert.ok((await applied) instanceof CancelledError);

  const quickPath = writeConfig(
    join(directory, "quick"),
    "main.xcl",
    `test "item" "first" {
  log   = ${JSON.stringify(log)}
  value = "one"
}
`,
  );

  await assert.doesNotReject(config.apply(quickPath));
});
