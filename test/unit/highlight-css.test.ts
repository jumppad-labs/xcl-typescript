import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { css } from "../../src/highlight/css.js";
import { Kind } from "../../src/highlight/kinds.js";
import { defaultTheme } from "../../src/highlight/theme.js";
import { missingReference, referenceOutput } from "../helpers/xcl-source.js";

const skip = missingReference();

test("the stylesheet from the default theme equals Go's", { skip }, () => {
  assert.equal(css(defaultTheme), referenceOutput("default.css"));
});

test("the stylesheet's class names are Go's", { skip }, () => {
  const classes = referenceOutput("classes.txt")
    .split("\n")
    .filter((line) => line !== "");
  const themeOfEveryKind = Object.fromEntries(Object.values(Kind).filter((value) => typeof value === "number" && value !== Kind.Text).map((kind) => [kind, "bold"]));
  const written = css(themeOfEveryKind)
    .split("\n")
    .filter((line) => line !== "")
    .map((rule) => (/^\.xcl \.([a-z-]+) \{/.exec(rule) as RegExpExecArray)[1]);
  assert.deepEqual(written, classes.slice(1));
});

test("a theme changing one kind differs from the default only in that kind's rule", () => {
  const before = css(defaultTheme).split("\n");
  const after = css({ ...defaultTheme, [Kind.Attribute]: "#ff8800" }).split("\n");
  assert.equal(after.length, before.length);
  const differences = before.flatMap((rule, index) => (rule === after[index] ? [] : [[rule, after[index]]]));
  assert.deepEqual(differences, [[".xcl .xcl-attribute { color: #2472c8; }", ".xcl .xcl-attribute { color: #ff8800; }"]]);
});

test("every rule is scoped under .xcl", () => {
  for (const rule of css({ ...defaultTheme, [Kind.Text]: "#eeeeee", [Kind.LineComment]: "underline" }).split("\n").filter((line) => line !== "")) {
    assert.ok(rule.startsWith(".xcl"), rule);
  }
});

test("a category's rule comes before its kinds' rules", () => {
  const stylesheet = css({ [Kind.LineComment]: "#ff0000", [Kind.Comment]: "#00ff00" });
  assert.ok(stylesheet.indexOf(".xcl .xcl-comment {") < stylesheet.indexOf(".xcl .xcl-line-comment {"));
});

test("a kind's rule resets the bold of its category", () => {
  assert.equal(css({ [Kind.Block]: "bold magenta", [Kind.BlockType]: "cyan" }), ".xcl .xcl-block { color: #bc3fbc; font-weight: bold; }\n.xcl .xcl-block-type { color: #11a8cd; font-weight: normal; }\n");
});

test("plain text's style writes the container's rule first", () => {
  assert.equal(css({ [Kind.Attribute]: "blue", [Kind.Text]: "#eeeeee" }), ".xcl { color: #eeeeee; }\n.xcl .xcl-attribute { color: #2472c8; }\n");
});

test("xcl-lang/xcl.css resolves through the package's exports and holds the same text", () => {
  const resolved = import.meta.resolve("xcl-lang/xcl.css");
  assert.match(resolved, /dist\/xcl\.css$/);
  assert.equal(readFileSync(fileURLToPath(resolved), "utf8"), css(defaultTheme));
});
