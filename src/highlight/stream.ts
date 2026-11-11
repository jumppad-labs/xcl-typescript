/** The opt-in colour choice: terminal colour for a terminal, plain text otherwise. */

import { plain, terminal, type Formatter } from "./formatters.js";

/**
 * The usual format for writing to `stream`, as Go's `highlight.For` chooses it:
 * `terminal` when `stream.isTTY` is true and the `NO_COLOR` environment variable
 * is unset or empty (see https://no-color.org), and `plain` otherwise. The
 * package never decides on its own whether to colour output: this is how a
 * caller asks it to make the usual choice.
 *
 * ```ts
 * printError(err, { formatter: forStream(process.stderr) });
 * ```
 */
export function forStream(stream: object): Formatter {
  if ((stream as { isTTY?: unknown }).isTTY !== true || (process.env.NO_COLOR ?? "") !== "") {
    return plain;
  }
  return terminal;
}
