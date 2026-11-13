/** The formatter type and the built-in formats, each a port of Go's, byte for byte. */

import { Kind, cssClassOf, isKnown, parentOf, type Token } from "./kinds.js";
import { hexColour, sgr, type Style } from "./style.js";
import { styleFor, type Theme } from "./theme.js";

/** Anything text can be written to, such as `process.stdout` or a collecting object. */
export interface Writer {
  /** Writes one chunk of text. */
  write(chunk: string): unknown;
}

/**
 * Turns labelled text into output on a writer. A format is given every token at
 * once, in order, so it can reason across them, such as by line or for a whole
 * document, and the theme to style them with, which it may ignore. The tokens
 * hold every byte of the text, `Kind.Text` tokens included. A function of this
 * type is accepted wherever a built-in format is.
 */
export type Formatter = (out: Writer, theme: Theme, tokens: readonly Token[]) => void;

/** Writes the text of the tokens with nothing added, ignoring the theme, as Go's `highlight.Plain`. */
export const plain: Formatter = (out, _theme, tokens) => {
  for (const token of tokens) {
    writeText(out, token.text);
  }
};

/**
 * Writes the tokens for a terminal in SGR escape codes from the theme, as Go's
 * `highlight.Terminal`. A token that spans lines is styled one line at a time,
 * with a reset before every line break, so indenting or prefixing a line never
 * bleeds colour. It always writes colour: whether to use it is the caller's
 * choice, which `forStream` makes the usual way.
 */
export const terminal: Formatter = (out, theme, tokens) => {
  for (const token of tokens) {
    const parameters = sgr(styleFor(theme, token.kind));
    if (parameters === "") {
      writeText(out, token.text);
      continue;
    }
    token.text.split("\n").forEach((line, index) => {
      if (index > 0) {
        out.write("\n");
      }
      if (line !== "") {
        out.write(`\x1b[${parameters}m${line}\x1b[0m`);
      }
    });
  }
};

/**
 * Writes the tokens as one `<pre class="xcl">` block with classes, as Go's
 * `highlight.HTML`. Each token that is not `Kind.Text` is in a span carrying its
 * kind's class and, when the kind belongs to a category, the category's class
 * first. The theme is ignored: a website styles the classes with its own
 * stylesheet, or one `css` generates from a theme.
 */
export const html: Formatter = (out, _theme, tokens) => {
  out.write('<pre class="xcl">');
  for (const token of tokens) {
    const classes = classesOf(token.kind);
    if (classes === "") {
      writeText(out, escape(token.text));
      continue;
    }
    out.write(`<span class="${classes}">${escape(token.text)}</span>`);
  }
  out.write("</pre>");
};

/**
 * Writes the same markup as `html`, styled from the theme with style
 * attributes, as Go's `highlight.HTMLInline`, for places a stylesheet cannot
 * reach, such as an email. A token the theme styles with nothing, and every
 * `Kind.Text` token, is written without a span; the block itself carries
 * `Kind.Text`'s style, when the theme gives it one.
 */
export const htmlInline: Formatter = (out, theme, tokens) => {
  const block = cssDeclarations(styleFor(theme, Kind.Text));
  out.write(block.length > 0 ? `<pre style="${escape(block.join("; "))}">` : "<pre>");
  for (const token of tokens) {
    const declarations = cssDeclarations(styleFor(theme, token.kind));
    if (token.kind === Kind.Text || declarations.length === 0) {
      writeText(out, escape(token.text));
      continue;
    }
    out.write(`<span style="${escape(declarations.join("; "))}">${escape(token.text)}</span>`);
  }
  out.write("</pre>");
};

// the geometry of SVG output, in user units: a monospace font 10 high, a
// character 6 wide, a line 14 high and a margin of 8 all round
const SVG_MARGIN = 8;
const SVG_CHAR_WIDTH = 6;
const SVG_LINE_HEIGHT = 14;
const SVG_BASELINE = 11;

/**
 * Writes the tokens as a standalone SVG image, as Go's `highlight.SVG`: one
 * `<text>` element per line with a `<tspan>` for each styled token. The view
 * box fits the longest line and every line. `Kind.Text`'s foreground colours
 * the whole image, and its background, when the theme gives one, fills it; a
 * token's own background is not drawn.
 */
export const svg: Formatter = (out, theme, tokens) => {
  const lines = svgLines(tokens);
  let columns = 0;
  for (const line of lines) {
    // Go counts runes, so a column is a code point rather than a UTF-16 unit
    columns = Math.max(columns, line.reduce((sum, piece) => sum + [...piece.text].length, 0));
  }
  const width = String(2 * SVG_MARGIN + SVG_CHAR_WIDTH * columns);
  const height = String(2 * SVG_MARGIN + SVG_LINE_HEIGHT * lines.length);

  const text = styleFor(theme, Kind.Text);
  out.write(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="monospace" font-size="10"`);
  if (text.foreground !== "") {
    out.write(` fill="${hexColour(text.foreground)}"`);
  }
  out.write(">\n");
  if (text.background !== "") {
    out.write(`<rect width="${width}" height="${height}" fill="${hexColour(text.background)}"/>\n`);
  }

  lines.forEach((line, index) => {
    const y = String(SVG_MARGIN + SVG_BASELINE + SVG_LINE_HEIGHT * index);
    out.write(`<text x="${SVG_MARGIN}" y="${y}" xml:space="preserve">`);
    for (const piece of line) {
      const attributes = svgAttributes(styleFor(theme, piece.kind));
      if (piece.kind === Kind.Text || attributes === "") {
        writeText(out, escape(piece.text));
        continue;
      }
      out.write(`<tspan${attributes}>${escape(piece.text)}</tspan>`);
    }
    out.write("</text>\n");
  });
  out.write("</svg>\n");
};

/** Writes `text` unless it is empty, as Go's formatters skip empty writes. */
function writeText(out: Writer, text: string): void {
  if (text !== "") {
    out.write(text);
  }
}

/** `text` escaped for HTML and XML, in content and in attributes, as Go escapes it (`'` as `&#39;`). */
function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** The classes of a kind's span: its category's class, when it belongs to one, then its own; `Kind.Text` has none. */
function classesOf(kind: number): string {
  if (kind === Kind.Text) {
    return "";
  }
  const own = cssClassOf(kind);
  if (own === "") {
    return "";
  }
  const parent = parentOf(kind);
  if (!isKnown(kind) || parent === kind) {
    return own;
  }
  const parentClass = cssClassOf(parent);
  return parentClass === "" ? own : `${parentClass} ${own}`;
}

/** The CSS declarations of a style, in the order colour, background colour, bold, italic, underline and dim. @internal */
export function cssDeclarations(style: Style): string[] {
  const declarations: string[] = [];
  if (style.foreground !== "") {
    declarations.push(`color: ${hexColour(style.foreground)}`);
  }
  if (style.background !== "") {
    declarations.push(`background-color: ${hexColour(style.background)}`);
  }
  if (style.bold) {
    declarations.push("font-weight: bold");
  }
  if (style.italic) {
    declarations.push("font-style: italic");
  }
  if (style.underline) {
    declarations.push("text-decoration: underline");
  }
  if (style.dim) {
    declarations.push("opacity: 0.5");
  }
  return declarations;
}

/** The tokens split into lines, each the pieces of the tokens on it, without the line breaks; a final line break ends the last line. */
function svgLines(tokens: readonly Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    token.text.split("\n").forEach((part, index) => {
      if (index > 0) {
        lines.push([]);
      }
      if (part !== "") {
        (lines[lines.length - 1] as Token[]).push({ kind: token.kind, text: part });
      }
    });
  }
  if (lines.length > 1 && (lines[lines.length - 1] as Token[]).length === 0) {
    lines.pop();
  }
  return lines;
}

/** The attributes of a tspan with a style, each with a leading space, in the order fill, bold, italic, underline and dim. */
function svgAttributes(style: Style): string {
  let attributes = "";
  if (style.foreground !== "") {
    attributes += ` fill="${hexColour(style.foreground)}"`;
  }
  if (style.bold) {
    attributes += ' font-weight="bold"';
  }
  if (style.italic) {
    attributes += ' font-style="italic"';
  }
  if (style.underline) {
    attributes += ' text-decoration="underline"';
  }
  if (style.dim) {
    attributes += ' opacity="0.5"';
  }
  return attributes;
}
