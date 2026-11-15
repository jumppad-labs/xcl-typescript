/** Checking a theme for style words a style does not understand. */

import { InvalidStyleError, type InvalidStyleWord } from "../errors.js";
import { unknownWords } from "./style.js";
import type { Theme } from "./theme.js";

/**
 * Checks every word of a theme's styles, as Go's `Theme.Validate` does. It
 * returns nothing for a theme it finds nothing wrong with, and throws one
 * `InvalidStyleError` naming every word a style does not understand otherwise,
 * in the order of the kinds and then of the words. Printing with a theme that
 * does not validate still works: the words are skipped.
 *
 * @param theme The theme to check.
 * @throws {@link InvalidStyleError} when any style in the theme holds a word a style does not understand; its `words` names each one.
 */
export function validateTheme(theme: Theme): void {
  const kinds = Object.keys(theme)
    .map(Number)
    .sort((left, right) => left - right);
  const found: InvalidStyleWord[] = [];
  for (const kind of kinds) {
    const style = theme[kind] ?? "";
    for (const word of unknownWords(style)) {
      found.push({ kind, style, word });
    }
  }
  if (found.length > 0) {
    throw new InvalidStyleError(found);
  }
}
