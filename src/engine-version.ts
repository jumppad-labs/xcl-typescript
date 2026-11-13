/** The version of the engine the package runs. */

import { sharedEngineClient } from "./config.js";
import type { Client } from "./internal/client.js";

/**
 * The version the bundled engine reports, such as `"v0.13.1"`, starting the
 * engine if it is not running yet. It is the xcl release pinned in the
 * package's `xcl-ref.txt` when it was built, which is versioned separately
 * from the package itself.
 *
 * Rejects with `EngineNotFoundError` when the engine cannot be found on first
 * use, and with `EngineVersionError` when the engine's version differs from
 * the one the package was built for.
 */
export function engineVersion(): Promise<string> {
  return engineVersionWith(sharedEngineClient());
}

/** The version the engine behind `client` reports, such as a fake transport's. @internal */
export function engineVersionWith(client: Client): Promise<string> {
  return client.engineVersion();
}
