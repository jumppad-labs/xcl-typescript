/**
 * Getting started: applies main.xcl with a Go plugin, published as a signed
 * GitHub release and installed on first use, and reads the result back.
 *
 *     npm install xcl-lang
 *     npm install --save-dev typescript @types/node
 *     npx tsc
 *     node build/main.js
 *
 * Run it from this directory: main.xcl and the release key are found relative
 * to it, and the state and the log the plugin writes land there too.
 */

import { readFileSync } from "node:fs";

import { createConfig, GitHubRegistry } from "xcl-lang";

// the jumppad-labs release key, from https://xcl.dev/keys/jumppad-labs-releases.asc
const releaseKey = readFileSync("jumppad-labs-releases.asc", "utf8");

const github = new GitHubRegistry({ trustedKeys: [releaseKey] });
github.registerPlugin("jumppad-labs/xcl-plugin-test", "v0.3.1");

await using config = await createConfig({ registries: [github], statePath: ".xcl" });

await config.apply("main.xcl");

const item = await config.find("test.item.second");
console.log(item.meta.id, item.attributes.value, item.attributes.input);
