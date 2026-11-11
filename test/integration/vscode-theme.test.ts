/** Loading VS Code colour themes through the real engine. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { html, InvalidThemeError, Kind, loadVSCodeTheme, terminal, type Theme } from "../../src/index.js";
import { missingEngine, testDirectory, writeConfig } from "../helpers/engine.js";

const skip = missingEngine();

const THEME = JSON.stringify({ tokenColors: [{ scope: "keyword", settings: { foreground: "#ff0088" } }] });

function written(theme: Theme, kind: number): string {
  let out = "";
  terminal({ write: (chunk) => (out += chunk) }, theme, [{ kind, text: "resource" }]);
  return out;
}

test("loading a colour theme file renders a keyword in the file's keyword colour", { skip }, async (t) => {
  const path = writeConfig(testDirectory(t), "theme.json", THEME);
  const theme = await loadVSCodeTheme(path);
  assert.equal(written(theme, Kind.Operator), "\x1b[38;2;255;0;136mresource\x1b[0m");
});

test("a colour theme's bytes load the same as its file", { skip }, async () => {
  const theme = await loadVSCodeTheme(new TextEncoder().encode(THEME));
  assert.equal(written(theme, Kind.Operator), "\x1b[38;2;255;0;136mresource\x1b[0m");
});

test("only the kinds the theme styles are returned", { skip }, async () => {
  const theme = await loadVSCodeTheme(new TextEncoder().encode(THEME));
  assert.equal(theme[Kind.String], undefined);
});

test("a file that is not a colour theme throws the invalid-theme error", { skip }, async () => {
  await assert.rejects(loadVSCodeTheme(new TextEncoder().encode("not json at all")), InvalidThemeError);
});

test("a loaded theme works with a built-in format", { skip }, async () => {
  const theme = await loadVSCodeTheme(new TextEncoder().encode(THEME));
  let out = "";
  html({ write: (chunk) => (out += chunk) }, theme, [{ kind: Kind.Operator, text: "x" }]);
  assert.match(out, /xcl-operator/);
});
