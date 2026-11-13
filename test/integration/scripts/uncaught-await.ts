/** A program with no printing code whose top-level await rejects with a configuration mistake. */

import { Config, LocalRegistry } from "../../../src/index.js";

const [configPath, pluginPath, statePath] = (process.env.XCL_TEST_ARGS ?? "").split("\n") as [string, string, string];

const local = new LocalRegistry();
local.registerExternalPlugin(pluginPath);
const config = await new Config({ registries: [local], statePath }).setup();

await config.validate(configPath);
