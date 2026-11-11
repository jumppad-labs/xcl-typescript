/**
 * Wrapping a report's detail to a width, exactly as Go's printing wraps it: a
 * port of `github.com/mitchellh/go-wordwrap` v1.0.1 `WrapString`, so a report
 * printed from Node is byte for byte the one Go prints.
 */

// what Go's unicode.IsSpace reports as space, the Unicode White_Space property
const SPACES: ReadonlySet<string> = new Set([
  "\t", "\n", "\v", "\f", "\r", " ", "\u0085", " ", " ",
  " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ",
  " ", " ", " ", " ", "　",
]);

// a no-break space is a space to Go, but go-wordwrap never breaks at one
const NO_BREAK_SPACE = " ";

/**
 * `text` wrapped at `width` columns between words, as Go's `report.Wrap` wraps
 * it. A width of null, undefined, 0 or less leaves the text unchanged. Lines
 * break only at spaces, never at a no-break space; a word longer than the width
 * is left whole on a line of its own; existing line breaks are kept. Widths are
 * counted in code points, as Go counts runes.
 */
export function wrapDetail(text: string, width: number | null | undefined): string {
  if (width === null || width === undefined || width <= 0) {
    return text;
  }

  const out: string[] = [];
  let current = 0;
  let word: string[] = [];
  let space: string[] = [];

  for (const char of text) {
    if (char === "\n") {
      if (word.length === 0) {
        if (current + space.length > width) {
          current = 0;
        } else {
          current += space.length;
          out.push(...space);
        }
        space = [];
      } else {
        current += space.length + word.length;
        out.push(...space);
        space = [];
        out.push(...word);
        word = [];
      }
      out.push(char);
      current = 0;
    } else if (SPACES.has(char) && char !== NO_BREAK_SPACE) {
      if (space.length === 0 || word.length > 0) {
        current += space.length + word.length;
        out.push(...space);
        space = [];
        out.push(...word);
        word = [];
      }
      space.push(char);
    } else {
      word.push(char);
      if (current + word.length + space.length > width && word.length < width) {
        out.push("\n");
        current = 0;
        space = [];
      }
    }
  }

  if (word.length === 0) {
    if (current + space.length <= width) {
      out.push(...space);
    }
  } else {
    out.push(...space);
    out.push(...word);
  }

  return out.join("");
}
