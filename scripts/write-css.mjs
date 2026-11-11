// Writes the default stylesheet into the build, from the compiled package, so
// the file a site links cannot differ from what css(defaultTheme) returns.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { css, defaultTheme } from "../dist/index.js";

writeFileSync(fileURLToPath(new URL("../dist/xcl.css", import.meta.url)), css(defaultTheme));
