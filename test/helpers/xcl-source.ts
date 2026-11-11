/** Where the xcl checkout's published reference outputs are. */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ROOT, skipReason } from "./engine.js";
import type { Token } from "../../src/highlight/kinds.js";

/** The directory of the reference outputs: in `XCL_SRC`, or the sibling `xcl` checkout by default. */
export function referenceDirectory(): string {
  return join(resolve(ROOT, process.env.XCL_SRC || "../xcl"), "highlight", "testdata", "reference");
}

/** Why tests needing the reference outputs cannot run, or false when they can. */
export function missingReference(): string | false {
  const directory = referenceDirectory();
  if (!existsSync(directory)) {
    return skipReason(`the reference outputs are not at ${directory}; set XCL_SRC to the xcl checkout`);
  }
  return false;
}

/** The tokens of the reference input `name`, read from `<name>.tokens.json`. */
export function referenceTokens(name: string): Token[] {
  return JSON.parse(readFileSync(join(referenceDirectory(), `${name}.tokens.json`), "utf8")) as Token[];
}

/** A reference output, with CRLF line ends turned back into LF, as a Windows checkout may write them. */
export function referenceOutput(fileName: string): string {
  return readFileSync(join(referenceDirectory(), fileName), "utf8").replaceAll("\r\n", "\n");
}
