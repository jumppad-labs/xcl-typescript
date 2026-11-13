#!/usr/bin/env node
/**
 * The release's install check: an installed xcl-lang does real work.
 *
 * Usage: node install-check.mjs <engine-tag>
 *
 * Run by the verify and install-check jobs of release.yml on every platform,
 * after installing the package with no Go or C compiler on the path. It is
 * copied into a project holding node_modules and the files of
 * examples/getting-started, and run from there, so `xcl-lang` resolves as it
 * does for a user's program. It needs nothing but Node and the package.
 *
 * It runs the getting-started flow: installs the signed test plugin from its
 * GitHub release, applies main.xcl, reads the entity back and closes the
 * configuration. Then it checks `engineVersion()` reports the engine tag, the
 * xcl release pinned in xcl-ref.txt at the package's tag, which is versioned
 * separately from the package. `XCL_CORE_PATH` is refused, since it would
 * replace the installed engine this check is here to test.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Config, engineVersion, GitHubRegistry } from "xcl-lang";

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
  throw new Error("usage: install-check.mjs <engine-tag>");
}
if (process.env.XCL_CORE_PATH) {
  throw new Error(`XCL_CORE_PATH is set to ${process.env.XCL_CORE_PATH}; the install check tests the installed engine`);
}

await runGettingStarted();

const version = await engineVersion();
console.log(`applied and read back test.item.second; engine ${version}`);
assert.equal(version, expected, `the engine reports ${version}, expected ${expected}`);
console.log(`install check passed: engine ${version}`);
