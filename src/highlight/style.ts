/** Style strings, the same words in every language, and the fixed colour palette. */

/**
 * The 16 named colours, each with the SGR foreground code a terminal shows it
 * with and the hex colour it is written as in HTML, SVG and CSS: a fixed
 * palette, the same in every language, since the terminal's bright-red has no
 * CSS name.
 */
const NAMED_COLOURS: ReadonlyMap<string, readonly [code: number, hex: string]> = new Map([
  ["black", [30, "#000000"]],
  ["red", [31, "#cd3131"]],
  ["green", [32, "#0dbc79"]],
  ["yellow", [33, "#e5e510"]],
  ["blue", [34, "#2472c8"]],
  ["magenta", [35, "#bc3fbc"]],
  ["cyan", [36, "#11a8cd"]],
  ["white", [37, "#e5e5e5"]],
  ["bright-black", [90, "#666666"]],
  ["bright-red", [91, "#f14c4c"]],
  ["bright-green", [92, "#23d18b"]],
  ["bright-yellow", [93, "#f5f543"]],
  ["bright-blue", [94, "#3b8eea"]],
  ["bright-magenta", [95, "#d670d6"]],
  ["bright-cyan", [96, "#29b8db"]],
  ["bright-white", [97, "#ffffff"]],
] as const);

/**
 * How a kind of text looks, parsed from a style string. `foreground` is empty,
 * a named colour such as `bright-red`, or `#rrggbb` in lower case;
 * `background` is empty or `#rrggbb`.
 */
export interface Style {
  /** Bold text. */
  bold: boolean;
  /** Italic text. */
  italic: boolean;
  /** Underlined text. */
  underline: boolean;
  /** Dimmed text. */
  dim: boolean;
  /** The foreground colour, or an empty string. */
  foreground: string;
  /** The background colour, or an empty string. */
  background: string;
}

function emptyStyle(): Style {
  return { bold: false, italic: false, underline: false, dim: false, foreground: "", background: "" };
}

function words(style: string): string[] {
  return style.split(/\s+/).filter((word) => word !== "");
}

/** A colour written `#rrggbb`, in either case, in lower case, or undefined when `word` is not one. */
function hexWord(word: string): string | undefined {
  return /^#[0-9a-fA-F]{6}$/.test(word) ? word.toLowerCase() : undefined;
}

/** Sets what `word` sets in `style`, and says whether a style understands the word. */
function applyWord(style: Style, word: string): boolean {
  if (word === "bold" || word === "italic" || word === "underline" || word === "dim") {
    style[word] = true;
    return true;
  }
  if (word.startsWith("bg:")) {
    const colour = hexWord(word.slice(3));
    if (colour === undefined) {
      return false;
    }
    style.background = colour;
    return true;
  }
  if (NAMED_COLOURS.has(word)) {
    style.foreground = word;
    return true;
  }
  const colour = hexWord(word);
  if (colour === undefined) {
    return false;
  }
  style.foreground = colour;
  return true;
}

/**
 * Reads a style string, such as `"bold #ff8800"`, as Go's `highlight.ParseStyle`
 * does. The words are separated by spaces, each one of `bold`, `italic`,
 * `underline`, `dim`, a foreground colour written `#rrggbb` or as one of the
 * named colours and their `bright-` forms, or a background colour written
 * `bg:#rrggbb`. A later word for the same thing wins. A word that is none of
 * these is skipped: parsing never fails, and `validateTheme` reports the words
 * skipped.
 */
export function parseStyle(style: string): Style {
  const parsed = emptyStyle();
  for (const word of words(style)) {
    applyWord(parsed, word);
  }
  return parsed;
}

/** The words of a style string a style does not understand, in order. @internal */
export function unknownWords(style: string): string[] {
  return words(style).filter((word) => !applyWord(emptyStyle(), word));
}

/** A colour as `#rrggbb`: a named colour through the fixed palette, a hex colour as it is, an empty string for none. @internal */
export function hexColour(colour: string): string {
  return NAMED_COLOURS.get(colour)?.[1] ?? colour;
}

function trueColour(prefix: string, colour: string): string {
  const hex = hexColour(colour);
  const channel = (start: number): number => (hex.length === 7 ? Number.parseInt(hex.slice(start, start + 2), 16) : 0);
  return `${prefix};2;${channel(1)};${channel(3)};${channel(5)}`;
}

/**
 * The SGR parameters of a style, such as `1;35`, or an empty string for a
 * style that sets nothing. The order is bold, dim, italic, underline, then the
 * foreground and the background colour. @internal
 */
export function sgr(style: Style): string {
  const parameters: string[] = [];
  if (style.bold) {
    parameters.push("1");
  }
  if (style.dim) {
    parameters.push("2");
  }
  if (style.italic) {
    parameters.push("3");
  }
  if (style.underline) {
    parameters.push("4");
  }
  if (style.foreground !== "") {
    const named = NAMED_COLOURS.get(style.foreground);
    parameters.push(named !== undefined ? String(named[0]) : trueColour("38", style.foreground));
  }
  if (style.background !== "") {
    const named = NAMED_COLOURS.get(style.background);
    parameters.push(named !== undefined ? String(named[0] + 10) : trueColour("48", style.background));
  }
  return parameters.join(";");
}
