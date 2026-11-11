/** Themes: a style string per kind, resolved through the kind's category and then plain text. */

import { Kind, parentOf } from "./kinds.js";
import { parseStyle, type Style } from "./style.js";

/**
 * A theme: a style string, such as `"bold #ff8800"`, for each kind it styles. A
 * kind it does not style takes its category's style, and a category it does not
 * style takes `Kind.Text`'s, so a short theme styles everything. A theme is
 * plain data, extended with a spread:
 *
 * ```ts
 * const theme = { ...defaultTheme, [Kind.Attribute]: "#ff8800" };
 * ```
 */
export type Theme = Readonly<Record<number, string>>;

/**
 * xcl's own look, the same as Go's `highlight.DefaultTheme`. It uses only the
 * terminal's 16 named colours, so in a terminal it follows the user's own
 * palette, and leaves `Kind.Text` unstyled. It is frozen.
 */
export const defaultTheme: Theme = Object.freeze({
  [Kind.Block]: "bold magenta",
  [Kind.Label]: "green",
  [Kind.TypeLabel]: "cyan",
  [Kind.Attribute]: "blue",
  [Kind.String]: "yellow",
  [Kind.StringEscape]: "bright-magenta",
  [Kind.Number]: "bright-magenta",
  [Kind.Constant]: "bright-magenta",
  [Kind.Reference]: "cyan",
  [Kind.Comment]: "italic bright-black",
  [Kind.Inserted]: "green",
  [Kind.Deleted]: "red",
  [Kind.Changed]: "yellow",
  [Kind.Error]: "bold red",
  [Kind.Warning]: "bold yellow",
  [Kind.Summary]: "bold",
  [Kind.Gutter]: "dim",
});

/**
 * How `kind` looks in `theme`: its own style, else its category's, else
 * `Kind.Text`'s. A style is taken whole, never merged with its category's, and
 * words a style does not understand are skipped.
 */
export function styleFor(theme: Theme, kind: number): Style {
  const own = theme[kind];
  if (own) {
    return parseStyle(own);
  }
  const category = theme[parentOf(kind)];
  if (category) {
    return parseStyle(category);
  }
  return parseStyle(theme[Kind.Text] ?? "");
}
