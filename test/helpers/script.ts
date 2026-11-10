/**
 * Runs a scenario in a fresh Node process.
 *
 * A test that depends on process state runs its scenario this way, so the
 * engine it watches belongs to that process alone rather than to whichever
 * engine the test file is running. A scenario is the source of an ES module,
 * importing the compiled package by absolute path through `SDK_MODULE` and
 * `TRANSPORT_MODULE`, that prints what it observes as `key:value` lines on its
 * standard output for the test to read back. Every wait is bounded, and a test
 * ends every process it starts.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT, skipReason } from "./engine.js";

/** How long a test waits for a scenario's next line or its exit, in milliseconds. */
export const SCRIPT_TIMEOUT_MS = 60_000;

/** How long a test waits for an engine to disappear, in milliseconds. */
export const ENGINE_GONE_TIMEOUT_MS = 5_000;

const DIST = join(ROOT, "dist");

/** The URL a scenario imports the public API from. */
export const SDK_MODULE = pathToFileURL(join(DIST, "index.js")).href;

/** The URL a scenario imports `sharedTransport` from, to read the engine's process id. */
export const TRANSPORT_MODULE = pathToFileURL(join(DIST, "internal", "subprocess.js")).href;

/** Why scenarios cannot run, or false when they can: they import the package `npm run build` compiles. */
export function missingBuild(): string | false {
  if (!existsSync(join(DIST, "index.js"))) {
    return skipReason(`the compiled package is not at ${DIST}; run npm run build`);
  }
  return false;
}

/** Waits for `milliseconds`. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** A scenario running in a fresh Node process, whose output lines are read with a timeout. */
export class Script {
  readonly process: ChildProcess;
  /** Every line of standard output, without its line ending. */
  readonly lines: string[] = [];
  /** Everything written to standard error. */
  stderr = "";
  /** The exit status, once the process has closed. */
  exitCode: number | null = null;
  /** The signal that ended the process, once it has closed. */
  signal: NodeJS.Signals | null = null;

  #partial = "";
  #cursor = 0;
  #closed = false;
  readonly #whenClosed: Promise<void>;

  /**
   * Writes `source` as `scenario.mjs` in `directory` and runs it, with `HOME`
   * pointed into `directory`, as plugins are cached under it.
   */
  constructor(source: string, directory: string, environment: Record<string, string> = {}) {
    const home = join(directory, "home");
    mkdirSync(home, { recursive: true });
    const file = join(directory, "scenario.mjs");
    writeFileSync(file, source);

    this.process = spawn(process.execPath, [file], {
      cwd: directory,
      env: { ...process.env, HOME: home, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      this.onStdout(chunk);
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

  private onStdout(chunk: string): void {
    const text = this.#partial + chunk;
    const finished = text.split("\n");
    this.#partial = finished.pop() ?? "";
    this.lines.push(...finished);
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
      await delay(10);
    }
  }

  /** The value of every line of output so far starting `prefix`. */
  values(prefix: string): string[] {
    return this.lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
  }

  /** Waits for the scenario to exit and its output to be read; kills it and rejects if it overruns. */
  async wait(timeoutMs = SCRIPT_TIMEOUT_MS): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    while (!this.#closed) {
      if (Date.now() >= deadline) {
        this.process.kill("SIGKILL");
        await this.#whenClosed;
        throw new Error(`the scenario did not exit within ${timeoutMs}ms; stderr:\n${this.stderr}`);
      }
      await delay(10);
    }
    return this.exitCode;
  }

  /** Ends the scenario if it is still running. */
  async close(): Promise<void> {
    if (!this.#closed) {
      this.process.kill("SIGKILL");
      await this.#whenClosed;
    }
  }
}

/** Runs `source` to its end in a fresh Node process and returns the finished script. */
export async function runScenario(source: string, directory: string, environment: Record<string, string> = {}): Promise<Script> {
  const script = new Script(source, directory, environment);
  try {
    await script.wait();
  } finally {
    await script.close();
  }
  return script;
}

/** Whether the process `pid` is still running; a zombie awaiting its parent counts as gone. */
export function processAlive(pid: number): boolean {
  if (process.platform === "win32") {
    return windowsProcessAlive(pid);
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    throw error;
  }
  return process.platform === "linux" ? linuxProcessRunning(pid) : posixProcessRunning(pid);
}

/** Whether `/proc` says `pid` is running: the state follows the command name, which is in parentheses. */
function linuxProcessRunning(pid: number): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return false;
  }
  const state = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0];
  return state !== "Z" && state !== "X";
}

/** Whether `ps` says `pid` is running, on a platform without `/proc`. */
function posixProcessRunning(pid: number): boolean {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  const state = result.stdout.trim();
  return state !== "" && !state.startsWith("Z");
}

/** Whether `tasklist` lists `pid`. */
function windowsProcessAlive(pid: number): boolean {
  const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  return result.stdout.includes(`"${pid}"`);
}

/** Waits up to `timeoutMs` for `pid` to disappear, polling; true when it has. */
export async function waitUntilGone(pid: number, timeoutMs = ENGINE_GONE_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      return true;
    }
    await delay(25);
  }
  return !processAlive(pid);
}

/** Makes sure a process a test left behind is gone, whatever the test concluded. */
export function endProcess(pid: number): void {
  if (!processAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, process.platform === "win32" ? "SIGTERM" : "SIGKILL");
  } catch {
    // it went between the check and the signal
  }
}
