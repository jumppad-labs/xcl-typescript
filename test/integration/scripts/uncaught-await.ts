/** A program with no printing code whose top-level await rejects with a configuration mistake. */

import { createConfig, LocalRegistry } from "../../../src/index.js";

const [configPath, pluginPath, statePath] = (process.env.XCL_TEST_ARGS ?? "").split("\n") as [string, string, string];

const local = new LocalRegistry();
local.registerExternalPlugin(pluginPath);
const config = await createConfig({ registries: [local], statePath });

await config.validate(configPath);
