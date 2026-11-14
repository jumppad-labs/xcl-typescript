/**
 * Getting started from CommonJS: the same program as examples/getting-started,
 * written as plain JavaScript that loads xcl-lang with require().
 *
 *     npm install xcl-lang
 *     node main.js
 *
 * Run it from this directory: main.xcl and the release key are found relative
 * to it, and the state and the log the plugin writes land there too.
 *
 * xcl-lang is an ES module, which Node 22.12 and later can require(). CommonJS
 * has no top-level await, so the program runs inside an async function and
 * closes the configuration in a finally block.
 */

const { readFileSync } = require("node:fs");

const { Config, EventDataLevel, GitHubRegistry, prettylog } = require("xcl-lang");

async function main() {
  // the jumppad-labs release key, from https://xcl.dev/keys/jumppad-labs-releases.asc
  const releaseKey = readFileSync("jumppad-labs-releases.asc", "utf8");

  const github = new GitHubRegistry({ trustedKeys: [releaseKey] });
  github.registerPlugin("jumppad-labs/xcl-plugin-test", "v0.3.1");

  const config = new Config({
    registries: [github],
    statePath: ".xcl",
    // a readable line per event on standard error, at the level XCL_LOG_LEVEL sets
    onEvent: prettylog.handler({ level: prettylog.levelFromEnv() }),
    // puts each created entity's configuration beneath its line
    eventData: EventDataLevel.Processed,
  });

  try {
    await config.apply("main.xcl");

    const item = await config.find("test.item.second");
    console.log(item.meta.id, item.attributes.value, item.attributes.input);
  } finally {
    await config.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
