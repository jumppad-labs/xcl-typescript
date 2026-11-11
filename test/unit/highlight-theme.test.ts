import assert from "node:assert/strict";
import { test } from "node:test";

import { InvalidStyleError, XclError } from "../../src/errors.js";
import { Kind } from "../../src/highlight/kinds.js";
import { defaultTheme, styleFor, type Theme } from "../../src/highlight/theme.js";
import type { Style } from "../../src/highlight/style.js";
import { validateTheme } from "../../src/highlight/validate.js";

function style(fields: Partial<Style>): Style {
  return { bold: false, italic: false, underline: false, dim: false, foreground: "", background: "", ...fields };
}

/** The error a theme fails validation with. */
function validationError(theme: Theme): InvalidStyleError {
  try {
    validateTheme(theme);
  } catch (error) {
    assert.ok(error instanceof InvalidStyleError);
    return error;
  }
  throw new Error("the theme validated");
}

test("a kind takes its own style", () => {
  assert.deepEqual(styleFor({ [Kind.Comment]: "italic", [Kind.LineComment]: "bold" }, Kind.LineComment), style({ bold: true }));
});

test("a kind given no style takes its category's", () => {
  assert.deepEqual(styleFor({ [Kind.Comment]: "italic" }, Kind.LineComment), style({ italic: true }));
});

test("a category given no style takes plain text's", () => {
  assert.deepEqual(styleFor({ [Kind.Text]: "#eeeeee" }, Kind.Attribute), style({ foreground: "#eeeeee" }));
});

test("an empty style falls back to the category's", () => {
  assert.deepEqual(styleFor({ [Kind.Comment]: "italic", [Kind.LineComment]: "" }, Kind.LineComment), style({ italic: true }));
});

test("an unknown kind takes its category's style", () => {
  assert.deepEqual(styleFor(defaultTheme, 1199), style({ italic: true, foreground: "bright-black" }));
});

test("a style for comments covers every kind of comment", () => {
  const theme = { ...defaultTheme, [Kind.Comment]: "#6a9955" };
  assert.deepEqual(styleFor(theme, Kind.LineComment), style({ foreground: "#6a9955" }));
  assert.deepEqual(styleFor(theme, Kind.HashComment), style({ foreground: "#6a9955" }));
  assert.deepEqual(styleFor(theme, Kind.BlockComment), style({ foreground: "#6a9955" }));
});

test("a new style for line comments alone changes only line comments", () => {
  const theme = { ...defaultTheme, [Kind.LineComment]: "bold #ff0000" };
  assert.deepEqual(styleFor(theme, Kind.LineComment), style({ bold: true, foreground: "#ff0000" }));
  assert.deepEqual(styleFor(theme, Kind.HashComment), styleFor(defaultTheme, Kind.HashComment));
  assert.deepEqual(styleFor(theme, Kind.BlockComment), styleFor(defaultTheme, Kind.BlockComment));
  assert.deepEqual(styleFor(theme, Kind.Attribute), styleFor(defaultTheme, Kind.Attribute));
});

test("extending the default keeps the styles not mentioned", () => {
  const theme = { ...defaultTheme, [Kind.Attribute]: "#ff8800" };
  assert.deepEqual(styleFor(theme, Kind.Attribute), style({ foreground: "#ff8800" }));
  assert.deepEqual(styleFor(theme, Kind.String), style({ foreground: "yellow" }));
  assert.deepEqual(styleFor(theme, Kind.BlockType), style({ bold: true, foreground: "magenta" }));
});

test("the default theme is Go's", () => {
  assert.deepEqual(
    { ...defaultTheme },
    {
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
    },
  );
});

test("the default theme cannot be changed in place", () => {
  assert.throws(() => {
    (defaultTheme as Record<number, string>)[Kind.Attribute] = "#ff8800";
  }, TypeError);
  assert.equal(defaultTheme[Kind.Attribute], "blue");
});

test("validating the default theme reports nothing", () => {
  assert.equal(validateTheme(defaultTheme), undefined);
});

test("validating a theme holding blinky reports that word", () => {
  const error = validationError({ ...defaultTheme, [Kind.Attribute]: "bold blinky" });
  assert.deepEqual(error.words, [{ kind: Kind.Attribute, style: "bold blinky", word: "blinky" }]);
  assert.equal(error.message, 'style "bold blinky" for Attribute: unknown word "blinky"');
  assert.equal(error.code, "invalid_style");
});

test("validation names every unknown word in kind order", () => {
  const error = validationError({ [Kind.String]: "purple", [Kind.Attribute]: "bold sparkly glitter" });
  assert.deepEqual(error.words, [
    { kind: Kind.Attribute, style: "bold sparkly glitter", word: "sparkly" },
    { kind: Kind.Attribute, style: "bold sparkly glitter", word: "glitter" },
    { kind: Kind.String, style: "purple", word: "purple" },
  ]);
});

test("validation names Go's kind name for a two-word kind", () => {
  assert.match(validationError({ [Kind.LineComment]: "faint" }).message, /for LineComment: unknown word "faint"/);
});

test("a validation error's message is one line", () => {
  const error = validationError({ [Kind.Attribute]: "one two" });
  assert.doesNotMatch(error.message, /\n/);
  assert.equal(error.message, 'style "one two" for Attribute: unknown word "one"; style "one two" for Attribute: unknown word "two"');
});

test("InvalidStyleError is an XclError", () => {
  assert.ok(validationError({ [Kind.Attribute]: "blinky" }) instanceof XclError);
});

test("an unknown word is ignored when a style is resolved", () => {
  assert.deepEqual(styleFor({ ...defaultTheme, [Kind.Attribute]: "bold sparkly" }, Kind.Attribute), style({ bold: true }));
});
