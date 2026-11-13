/** Labelled text through a format, with a report's detail wrapped: the one print-time step this package takes. */

import { plain, type Formatter, type Writer } from "../highlight/formatters.js";
import { Kind, type Token } from "../highlight/kinds.js";
import { defaultTheme, type Theme } from "../highlight/theme.js";
import { wrapDetail } from "./wrap.js";

/** A writer collecting what is written to it. */
export class StringWriter implements Writer {
  text = "";

  write(chunk: string): void {
    this.text += chunk;
  }
}

/**
 * `tokens` with each `Kind.Detail` token wrapped at `width`, as Go's
 * `PrintError` wraps them. Only detail is wrapped, never source lines. A width
 * of null, undefined, 0 or less leaves every token as it is.
 */
export function wrapped(tokens: readonly Token[], width: number | null | undefined): Token[] {
  if (width === null || width === undefined || width <= 0) {
    return [...tokens];
  }
  return tokens.map((token) => (token.kind === Kind.Detail ? { kind: token.kind, text: wrapDetail(token.text, width) } : token));
}

/** `tokens`, with detail wrapped at `width`, as `formatter` writes them with `theme`. */
export function render(tokens: readonly Token[], formatter: Formatter, theme: Theme, width: number | null | undefined): string {
  const out = new StringWriter();
  formatter(out, theme, wrapped(tokens, width));
  return out.text;
}

/** The plain report of `tokens` wrapped at 80 columns, without trailing line breaks. */
export function plainReport(tokens: readonly Token[]): string {
  return render(tokens, plain, defaultTheme, 80).replace(/\n+$/, "");
}
