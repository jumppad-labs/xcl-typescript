/**
 * The built-in formats, checked byte for byte against xcl's published reference
 * outputs: each input's tokens, formatted with the default theme, give the
 * published output exactly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { html, htmlInline, plain, svg, terminal, type Formatter } from "../../src/highlight/formatters.js";
import { defaultTheme } from "../../src/highlight/theme.js";
import { missingReference, referenceOutput, referenceTokens } from "../helpers/xcl-source.js";

const skip = missingReference();

/** What `format` writes for the reference input `name`. */
function formatted(format: Formatter, name: string): string {
  let written = "";
  format({ write: (chunk) => (written += chunk) }, defaultTheme, referenceTokens(name));
  return written;
}

test("the report in plain text equals Go's", { skip }, () => {
  assert.equal(formatted(plain, "report"), referenceOutput("report.plain.txt"));
});

test("the report in terminal colour equals Go's", { skip }, () => {
  assert.equal(formatted(terminal, "report"), referenceOutput("report.terminal.txt"));
});

test("the report in HTML with classes equals Go's", { skip }, () => {
  assert.equal(formatted(html, "report"), referenceOutput("report.html"));
});

test("the report in inline HTML equals Go's", { skip }, () => {
  assert.equal(formatted(htmlInline, "report"), referenceOutput("report.inline.html"));
});

test("the report in SVG equals Go's", { skip }, () => {
  assert.equal(formatted(svg, "report"), referenceOutput("report.svg"));
});

test("the entity in plain text equals Go's", { skip }, () => {
  assert.equal(formatted(plain, "entity"), referenceOutput("entity.plain.txt"));
});

test("the entity in terminal colour equals Go's", { skip }, () => {
  assert.equal(formatted(terminal, "entity"), referenceOutput("entity.terminal.txt"));
});

test("the entity in HTML with classes equals Go's", { skip }, () => {
  assert.equal(formatted(html, "entity"), referenceOutput("entity.html"));
});

test("the entity in inline HTML equals Go's", { skip }, () => {
  assert.equal(formatted(htmlInline, "entity"), referenceOutput("entity.inline.html"));
});

test("the entity in SVG equals Go's", { skip }, () => {
  assert.equal(formatted(svg, "entity"), referenceOutput("entity.svg"));
});

test("the change summary in plain text equals Go's", { skip }, () => {
  assert.equal(formatted(plain, "diff"), referenceOutput("diff.plain.txt"));
});

test("the change summary in terminal colour equals Go's", { skip }, () => {
  assert.equal(formatted(terminal, "diff"), referenceOutput("diff.terminal.txt"));
});

test("the change summary in HTML with classes equals Go's", { skip }, () => {
  assert.equal(formatted(html, "diff"), referenceOutput("diff.html"));
});

test("the change summary in inline HTML equals Go's", { skip }, () => {
  assert.equal(formatted(htmlInline, "diff"), referenceOutput("diff.inline.html"));
});

test("the change summary in SVG equals Go's", { skip }, () => {
  assert.equal(formatted(svg, "diff"), referenceOutput("diff.svg"));
});
