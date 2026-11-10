/**
 * Where the real engine and the fixture plugins are, and what a test does when
 * one of them is missing.
 *
 * The engine is `XCL_CORE_PATH` when it is set, and otherwise the program
 * `make engine` builds into `build/engine`, which is then published as
 * `XCL_CORE_PATH` for the package under test to find. The fixture plugins are
 * what `make plugins` builds into `build/plugins`.
 *
 * Every test file works out what it is missing when it is loaded and passes the
 * answer as the `skip` of its tests. In a run with `XCL_TEST_STRICT=1`, as CI
 * sets, missing anything throws instead, so a run that should have had it can
 * never go green with its tests skipped.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

/** Set to 1 to make anything missing a failure rather than a skip. */
export const STRICT_ENV = "XCL_TEST_STRICT";

/** The root of this package's checkout; this file compiles to `build/test/test/helpers/engine.js`. */
export const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** The directory `make plugins` builds the fixture plugins into. */
export const PLUGIN_DIRECTORY = join(ROOT, "build", "plugins");

const EXECUTABLE_SUFFIX = process.platform === "win32" ? ".exe" : "";

/** The program `make engine` builds. */
export const BUILT_ENGINE = join(ROOT, "build", "engine", `xcl-core${EXECUTABLE_SUFFIX}`);

/** The file name of the slow fixture plugin: `resource "slow" "<name>" { delay_ms = ... }`. */
export const SLOW_PLUGIN = `xcl-plugin-slow${EXECUTABLE_SUFFIX}`;

/** The file name of the recording fixture plugin: `resource "recording" "<name>" { log = ... }`. */
export const RECORDING_PLUGIN = `xcl-plugin-recording${EXECUTABLE_SUFFIX}`;

/** Whether this is a strict run, in which anything missing fails rather than skips. */
export function strict(): boolean {
  return process.env[STRICT_ENV] === "1";
}

/** Returns `reason` to skip with, or throws it in a strict run. */
export function skipReason(reason: string): string {
  if (strict()) {
    throw new Error(`${reason} (${STRICT_ENV}=1 turns this skip into a failure)`);
  }
  return reason;
}

/** The engine the run uses: `XCL_CORE_PATH` when set, otherwise the built one. */
export function enginePath(): string {
  return process.env.XCL_CORE_PATH || BUILT_ENGINE;
}

/**
 * Why tests needing the engine cannot run, or false when they can. Publishes
 * the engine it found as `XCL_CORE_PATH`, which is how the package finds it.
 */
export function missingEngine(): string | false {
  const engine = enginePath();
  if (!existsSync(engine)) {
    return skipReason(`the xcl engine is not at ${engine}; run make engine, or set XCL_CORE_PATH`);
  }
  process.env.XCL_CORE_PATH = engine;
  return false;
}

/** The path of the fixture plugin `name`. */
export function pluginPath(name: string): string {
  return join(PLUGIN_DIRECTORY, name);
}

/** Why tests needing the fixture plugin `name` cannot run, or false when they can. */
export function missingPlugin(name: string): string | false {
  const plugin = pluginPath(name);
  if (!existsSync(plugin)) {
    return skipReason(`the fixture plugin is not at ${plugin}; run make plugins`);
  }
  return false;
}

/** A new directory removed when the test `t` ends. */
export function testDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "xcl-ts-"));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/**
 * A new directory shared by the tests of the file loading this helper, removed
 * when they have all ended. It must be called while the file loads, so the
 * removal runs after the last test rather than after the current one.
 */
export function sharedDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "xcl-ts-shared-"));
  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/**
 * Points `HOME` at a new directory for the rest of the test file, as plugins are
 * cached under it by default. Call it while the file loads, before any engine
 * starts: the engine and the plugins it starts inherit this process's
 * environment.
 */
export function isolateHome(): string {
  const home = sharedDirectory();
  const previous = process.env.HOME;
  process.env.HOME = home;
  after(() => {
    if (previous === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previous;
    }
  });
  return home;
}

/** Writes `text` to `name` under `directory` and returns its path. */
export function writeConfig(directory: string, name: string, text: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, text);
  return path;
}
