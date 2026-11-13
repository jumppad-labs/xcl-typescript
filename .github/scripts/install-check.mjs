#!/usr/bin/env node
/**
 * The release's install check: an installed xcl-lang does real work.
 *
 * Usage: node install-check.mjs <tag>
 *
 * Run by the verify and install-check jobs of release.yml on every platform,
 * after installing the package with no Go or C compiler on the path. It is
 * copied into a project holding node_modules and the files of
 * examples/getting-started, and run from there, so `xcl-lang` resolves as it
 * does for a user's program. It needs nothing but Node and the package.
 *
 * It checks the installed platform package's engine reports the tag, then runs
 * the getting-started flow: installs the signed test plugin from its GitHub
 * release, applies main.xcl, reads the entity back and closes the
 * configuration. The package's public API has no accessor for the engine's
 * version, so the version comes from `xcl-core --version` of the program the
 * package itself would run. `XCL_CORE_PATH` is refused, since it would replace
 * the installed engine this check is here to test.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { Config, GitHubRegistry } from "xcl-lang";

/** The engine package for this platform, chosen as the SDK chooses it. */
function platformPackage() {
  if (process.platform !== "linux") {
    return `@jumppad-labs/xcl-lang-${process.platform}-${process.arch}`;
  }
  // a report otherwise looks up every network interface, which can take seconds
  process.report.excludeNetwork = true;
  const libc = process.report.getReport().header.glibcVersionRuntime ? "gnu" : "musl";
  return `@jumppad-labs/xcl-lang-linux-${process.arch}-${libc}`;
}

/** The version the installed platform package's `xcl-core` reports. */
function installedEngineVersion() {
  const packageName = platformPackage();
  const manifest = createRequire(import.meta.url).resolve(`${packageName}/package.json`);
  const program = join(dirname(manifest), "bin", process.platform === "win32" ? "xcl-core.exe" : "xcl-core");
  const version = execFileSync(program, ["--version"], { encoding: "utf8" }).trim();
  console.log(`${packageName}: ${program} reports ${version}`);
  return version;
}

/** The steps of examples/getting-started/main.ts, without its TypeScript. */
async function runGettingStarted() {
  const releaseKey = readFileSync("jumppad-labs-releases.asc", "utf8");

  const github = new GitHubRegistry({ trustedKeys: [releaseKey] });
  github.registerPlugin("jumppad-labs/xcl-plugin-test", "v0.3.1");

  const config = new Config({ registries: [github], statePath: ".xcl" });
  try {
    await config.apply("main.xcl");

    const item = await config.find("test.item.second");
    assert.equal(item.meta.id, "test.item.second");
    assert.equal(item.attributes.value, "two");
    assert.equal(item.attributes.input, "first-one");
    console.log(`applied and read back ${item.meta.id}`);
  } finally {
    await config.close();
  }
}

const expected = process.argv[2];
if (!expected) {
  throw new Error("usage: install-check.mjs <tag>");
}
if (process.env.XCL_CORE_PATH) {
  throw new Error(`XCL_CORE_PATH is set to ${process.env.XCL_CORE_PATH}; the install check tests the installed engine`);
}

const version = installedEngineVersion();
assert.equal(version, expected, `the installed engine reports ${version}, expected ${expected}`);

await runGettingStarted();
console.log(`install check passed: engine ${version}`);
