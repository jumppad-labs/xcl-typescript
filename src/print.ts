/** Printing errors, entities and change summaries for a person to read, in one call. */

import { inspect } from "node:util";

import type { Diff } from "./diff.js";
import { XclError } from "./errors.js";
import { plain, type Formatter, type Writer } from "./highlight/formatters.js";
import type { Token } from "./highlight/kinds.js";
import { defaultTheme, type Theme } from "./highlight/theme.js";
import { render, wrapped } from "./internal/render.js";

/** How printed text is laid out. */
export interface FormatOptions {
  /** The output format, by default `plain`; `forStream` chooses one from a stream. */
  formatter?: Formatter;
  /** The theme, by default `defaultTheme`; extend it with a spread. */
  theme?: Theme;
  /** The column a report's detail wraps at, by default 80; 0 or null never wraps. */
  width?: number | null;
}

/** Where printed text goes, and how it is laid out. */
export interface PrintOptions extends FormatOptions {
  /** The writer, by default `process.stderr` for an error and `process.stdout` for a change summary. */
  out?: Writer;
}

const DEFAULT_WIDTH = 80;

/**
 * Prints `err` for a person to read, as Go's `xcl.PrintError` prints it. An
 * `XclError` holding configuration problems prints its report: each problem's
 * severity and summary, where it is, the numbered source lines around it with
 * the fault marked, and its detail, wrapped at 80 columns unless `width` says
 * otherwise. Any other error prints its message and a line break, and any other
 * value its text form, so printing never throws. The output is plain text
 * unless `formatter` chooses another format.
 *
 * ```ts
 * try {
 *   await cfg.apply("./config");
 * } catch (err) {
 *   printError(err, { formatter: forStream(process.stderr) });
 *   process.exitCode = 1;
 * }
 * ```
 */
export function printError(err: unknown, options: PrintOptions = {}): void {
  const out = options.out ?? process.stderr;
  const tokens = tokensOf(err);
  if (tokens.length === 0) {
    out.write(`${textOf(err)}\n`);
    return;
  }
  (options.formatter ?? plain)(out, options.theme ?? defaultTheme, wrapped(tokens, widthOf(options)));
}

/**
 * `err` as `printError` prints it, as a string. The HTML formats return markup
 * already escaped, ready to put into a page.
 */
export function formatError(err: unknown, options: FormatOptions = {}): string {
  const tokens = tokensOf(err);
  if (tokens.length === 0) {
    return `${textOf(err)}\n`;
  }
  return render(tokens, options.formatter ?? plain, options.theme ?? defaultTheme, widthOf(options));
}

/**
 * Prints a change summary, the git-style one the engine lays out for the diff,
 * as Go's `xcl.PrintDiff` prints it, to `process.stdout` by default.
 *
 * ```ts
 * printDiff(await cfg.diff("./config"), { formatter: forStream(process.stdout) });
 * ```
 *
 * Throws `TypeError` for a diff with no labelled text, such as one built by
 * hand: only a diff returned by `Config.diff` carries it.
 */
export function printDiff(diff: Diff, options: Omit<PrintOptions, "width"> = {}): void {
  if (diff.tokens.length === 0) {
    throw new TypeError("this diff has no labelled text to print: only a diff returned by Config.diff carries it");
  }
  (options.formatter ?? plain)(options.out ?? process.stdout, options.theme ?? defaultTheme, diff.tokens);
}

function widthOf(options: FormatOptions): number | null {
  return options.width === undefined ? DEFAULT_WIDTH : options.width;
}

function tokensOf(err: unknown): readonly Token[] {
  return err instanceof XclError ? err.tokens : [];
}

/** An error's message or a value's text form, never throwing, whatever the value is. */
function textOf(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return inspect(err);
  }
}
