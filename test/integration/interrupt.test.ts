/**
 * Ctrl-C against the real engine, in fresh Node processes.
 *
 * A scenario runs in a session of its own, as a terminal gives a foreground
 * job, and SIGINT goes to the whole process group as Ctrl-C does: the program,
 * its engine and the plugins. The engine discards SIGINT, and what the program
 * does decides the rest. Scenarios are plain JavaScript importing the compiled
 * package, and print what they observe as `key:value` lines.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { missingEngine, missingPlugin, pluginPath, SLOW_PLUGIN, testDirectory, writeConfig } from "../helpers/engine.js";
import { ENGINE_GONE_TIMEOUT_MS, endProcess, missingBuild, runScenario, SCRIPT_TIMEOUT_MS, SDK_MODULE, TRANSPORT_MODULE, waitUntilGone } from "../helpers/script.js";

const needsPlugin = missingEngine() || missingBuild() || missingPlugin(SLOW_PLUGIN);
const posixOnly = process.platform === "win32" ? "POSIX signals are not available on Windows" : false;

/** How long an interrupted scenario has to end, in milliseconds. */
const INTERRUPT_TIMEOUT_MS = 20_000;

/** A scenario in a process group of its own, so a signal can go to the whole group. */
class GroupScenario {
  readonly process: ChildProcess;
  readonly lines: string[] = [];
  stderr = "";
  exitCode: number | null = null;
  signal: NodeJS.Signals | null = null;

  #partial = "";
  #cursor = 0;
  #closed = false;
  readonly #whenClosed: Promise<void>;

  constructor(source: string, directory: string) {
    const home = join(directory, "home");
    mkdirSync(home, { recursive: true });
    const file = join(directory, "scenario.mjs");
    writeFileSync(file, source);

    this.process = spawn(process.execPath, [file], {
      cwd: directory,
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.process.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      const text = this.#partial + chunk;
      const finished = text.split("\n");
      this.#partial = finished.pop() ?? "";
      this.lines.push(...finished);
    });
    this.process.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.#whenClosed = new Promise((resolve) => {
      this.process.on("close", (code, signal) => {
        this.exitCode = code;
        this.signal = signal;
        this.#closed = true;
        resolve();
      });
    });
  }

  /** The value of the next line starting `prefix`, skipping others; rejects if none arrives in time. */
  async expect(prefix: string, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.#cursor < this.lines.length) {
        const line = this.lines[this.#cursor] as string;
        this.#cursor += 1;
        if (line.startsWith(prefix)) {
          return line.slice(prefix.length);
        }
      }
      if (this.#closed) {
        throw new Error(`the scenario ended without printing a ${prefix} line; stderr:\n${this.stderr}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`the scenario printed no ${prefix} line within ${timeoutMs}ms; stderr:\n${this.stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** The value of every line of output so far starting `prefix`. */
  values(prefix: string): string[] {
    return this.lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
  }

  /** Sends SIGINT to every process of the scenario's group, as Ctrl-C does. */
  interrupt(): void {
    process.kill(-(this.process.pid as number), "SIGINT");
  }

  /** Waits for the scenario to exit and its output to be read; rejects if it overruns. */
  async wait(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.#closed) {
      if (Date.now() >= deadline) {
        throw new Error(`the scenario did not exit within ${timeoutMs}ms; stdout:\n${this.lines.join("\n")}\nstderr:\n${this.stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Ends every process of the group that is still running, whatever the test concluded. */
  async end(): Promise<void> {
    try {
      process.kill(-(this.process.pid as number), "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
    await this.#whenClosed;
  }
}

/**
 * Writes the three slow resources, each depending on the last. `two` holds the
 * apply for a second and a half: the engine lets a provider call in flight
 * finish, and it stays alive for that long after the program has gone.
 */
function writeSequence(directory: string): string {
  return writeConfig(
    directory,
    "main.xcl",
    `resource "slow" "one" {
  delay_ms = 1
}

resource "slow" "two" {
  delay_ms   = 1500
  depends_on = ["resource.slow.one"]
}

resource "slow" "three" {
  delay_ms   = 1
  depends_on = ["resource.slow.two"]
}
`,
  );
}

/** The addresses of the records in the state directory `state`. */
function savedAddresses(state: string): string[] {
  const records = JSON.parse(readFileSync(join(state, "state.json"), "utf8")) as { meta: { id: string } }[];
  return records.map((record) => record.meta.id);
}

/** The start of a scenario: a configuration printing when `two` starts, and its engine's process id. */
function openConfigSource(directory: string): string {
  return `import { CancelledError, Config, interruptSignal, LocalRegistry } from ${JSON.stringify(SDK_MODULE)};
import { sharedTransport } from ${JSON.stringify(TRANSPORT_MODULE)};

const registry = new LocalRegistry();
registry.registerExternalPlugin(${JSON.stringify(pluginPath(SLOW_PLUGIN))});

const config = await new Config({
  registries: [registry],
  statePath: ${JSON.stringify(join(directory, "state"))},
  onEvent: (event) => {
    if (event.resourceId === "resource.slow.two" && event.operation === "create" && event.phase === "start") {
      console.log("two:started");
    }
  },
}).setup();
console.log("pid:" + sharedTransport().pid);
`;
}

/** Starts `source` in its own group, and has the test `t` end it, its group and the engine it printed. */
function startScenario(t: TestContext, source: string, directory: string): GroupScenario {
  const scenario = new GroupScenario(source, directory);
  t.after(async () => {
    await scenario.end();
    for (const pid of scenario.values("pid:")) {
      endProcess(Number(pid));
    }
  });
  return scenario;
}

// -- a program that opted in --------------------------------------------------

test("a SIGINT rejects an opted-in apply, the program's own code runs, and no listener remains", { skip: needsPlugin || posixOnly }, async (t) => {
  const directory = testDirectory(t);
  const path = writeSequence(directory);
  const scenario = startScenario(
    t,
    `${openConfigSource(directory)}
const signal = interruptSignal();
console.log("listening:" + process.listenerCount("SIGINT"));
try {
  await config.apply(${JSON.stringify(path)}, { signal });
  console.log("outcome:completed");
} catch (error) {
  console.log("outcome:" + (error instanceof CancelledError ? "cancelled" : String(error)));
}
console.log("listeners:" + process.listenerCount("SIGINT"));
console.log("own-code:ran");
await config.close();
`,
    directory,
  );

  const pid = Number(await scenario.expect("pid:"));
  assert.equal(await scenario.expect("listening:"), "1");
  await scenario.expect("two:started");
  scenario.interrupt();
  await scenario.wait(INTERRUPT_TIMEOUT_MS);

  assert.equal(scenario.exitCode, 0, scenario.stderr);
  assert.deepEqual(scenario.values("outcome:"), ["cancelled"], scenario.stderr);
  assert.deepEqual(scenario.values("listeners:"), ["0"], scenario.stderr);
  assert.deepEqual(scenario.values("own-code:"), ["ran"], scenario.stderr);
  assert.ok(await waitUntilGone(pid), `the engine ${pid} was still running ${ENGINE_GONE_TIMEOUT_MS}ms after the program exited`);
});

test("after an opted-in apply settles a SIGINT ends the program as Node does by default", { skip: needsPlugin || posixOnly }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(
    directory,
    "main.xcl",
    `resource "slow" "quick" {
  delay_ms = 1
}
`,
  );
  const scenario = startScenario(
    t,
    `${openConfigSource(directory)}
await config.apply(${JSON.stringify(path)}, { signal: interruptSignal() });
console.log("listeners:" + process.listenerCount("SIGINT"));
await config.close();
console.log("applied:yes");
setTimeout(() => {
  console.log("outcome:survived");
}, ${SCRIPT_TIMEOUT_MS});
`,
    directory,
  );

  await scenario.expect("applied:");
  scenario.interrupt();
  await scenario.wait(INTERRUPT_TIMEOUT_MS);

  assert.deepEqual(scenario.values("listeners:"), ["0"], scenario.stderr);
  assert.deepEqual(scenario.values("outcome:"), [], scenario.stderr);
  assert.ok(scenario.signal === "SIGINT" || scenario.exitCode === 130, `the program ended with code ${scenario.exitCode} and signal ${scenario.signal}`);
});

// -- a program that did not opt in --------------------------------------------

test("importing the package and running an apply adds no SIGINT listener", { skip: needsPlugin }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(
    directory,
    "main.xcl",
    `resource "slow" "quick" {
  delay_ms = 1
}
`,
  );

  const script = await runScenario(
    `console.log("before-import:" + process.listenerCount("SIGINT"));
const { Config, LocalRegistry } = await import(${JSON.stringify(SDK_MODULE)});
console.log("after-import:" + process.listenerCount("SIGINT"));

const registry = new LocalRegistry();
registry.registerExternalPlugin(${JSON.stringify(pluginPath(SLOW_PLUGIN))});
const config = await new Config({
  registries: [registry],
  statePath: ${JSON.stringify(join(directory, "state"))},
  onEvent: (event) => {
    if (event.resourceId === "resource.slow.quick" && event.operation === "create" && event.phase === "start") {
      console.log("during-apply:" + process.listenerCount("SIGINT"));
    }
  },
}).setup();
console.log("after-create:" + process.listenerCount("SIGINT"));
await config.apply(${JSON.stringify(path)});
console.log("after-apply:" + process.listenerCount("SIGINT"));
await config.close();
`,
    directory,
  );

  assert.equal(script.exitCode, 0, script.stderr);
  assert.deepEqual(script.values("before-import:"), ["0"], script.stderr);
  assert.deepEqual(script.values("after-import:"), ["0"], script.stderr);
  assert.deepEqual(script.values("after-create:"), ["0"], script.stderr);
  assert.deepEqual(script.values("during-apply:"), ["0"], script.stderr);
  assert.deepEqual(script.values("after-apply:"), ["0"], script.stderr);
});

test("a SIGINT ends a program that did not opt in as Node does by default", { skip: needsPlugin || posixOnly }, async (t) => {
  const directory = testDirectory(t);
  const path = writeSequence(directory);
  const scenario = startScenario(
    t,
    `${openConfigSource(directory)}
await config.apply(${JSON.stringify(path)});
console.log("outcome:completed");
`,
    directory,
  );

  await scenario.expect("pid:");
  await scenario.expect("two:started");
  scenario.interrupt();
  await scenario.wait(INTERRUPT_TIMEOUT_MS);

  assert.deepEqual(scenario.values("outcome:"), [], scenario.stderr);
  assert.ok(scenario.signal === "SIGINT" || scenario.exitCode === 130, `the program ended with code ${scenario.exitCode} and signal ${scenario.signal}`);
});

test("a SIGINT to a program that did not opt in leaves completed entities in the state directory and no engine running", { skip: needsPlugin || posixOnly }, async (t) => {
  const directory = testDirectory(t);
  const path = writeSequence(directory);
  const scenario = startScenario(
    t,
    `${openConfigSource(directory)}
await config.apply(${JSON.stringify(path)});
`,
    directory,
  );

  const pid = Number(await scenario.expect("pid:"));
  await scenario.expect("two:started");
  scenario.interrupt();
  await scenario.wait(INTERRUPT_TIMEOUT_MS);

  assert.ok(await waitUntilGone(pid), `the engine ${pid} was still running ${ENGINE_GONE_TIMEOUT_MS}ms after its host was interrupted`);
  assert.ok(savedAddresses(join(directory, "state")).includes("resource.slow.one"), `the state holds: ${savedAddresses(join(directory, "state")).join(", ")}`);
});
