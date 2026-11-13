/** A program with no printing code that lets a configuration mistake go uncaught from a callback. */

import { Config, LocalRegistry } from "../../../src/index.js";

const [configPath, pluginPath, statePath] = (process.env.XCL_TEST_ARGS ?? "").split("\n") as [string, string, string];

const local = new LocalRegistry();
local.registerExternalPlugin(pluginPath);
const config = await new Config({ registries: [local], statePath }).setup();

config.validate(configPath).catch((error: unknown) => {
  setImmediate(() => {
    throw error;
  });
});
