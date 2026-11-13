import assert from "node:assert/strict";
import { test } from "node:test";

import { hexColour, parseStyle, sgr, type Style } from "../../src/highlight/style.js";

function style(fields: Partial<Style>): Style {
  return { bold: false, italic: false, underline: false, dim: false, foreground: "", background: "", ...fields };
}

test("bold parses", () => {
  assert.deepEqual(parseStyle("bold"), style({ bold: true }));
});

test("italic parses", () => {
  assert.deepEqual(parseStyle("italic"), style({ italic: true }));
});

test("underline parses", () => {
  assert.deepEqual(parseStyle("underline"), style({ underline: true }));
});

test("dim parses", () => {
  assert.deepEqual(parseStyle("dim"), style({ dim: true }));
});

test("a hex foreground parses", () => {
  assert.deepEqual(parseStyle("#ff8800"), style({ foreground: "#ff8800" }));
});

test("an upper-case hex colour is stored in lower case", () => {
  assert.deepEqual(parseStyle("#FF8800"), style({ foreground: "#ff8800" }));
});

test("a background parses", () => {
  assert.deepEqual(parseStyle("bg:#102030"), style({ background: "#102030" }));
});

test("a named colour parses", () => {
  assert.deepEqual(parseStyle("red"), style({ foreground: "red" }));
});

test("a bright named colour parses", () => {
  assert.deepEqual(parseStyle("bright-magenta"), style({ foreground: "bright-magenta" }));
});

test("several words parse together", () => {
  assert.deepEqual(parseStyle("bold italic #00ff88"), style({ bold: true, italic: true, foreground: "#00ff88" }));
});

test("a later colour wins", () => {
  assert.deepEqual(parseStyle("red #ff8800 blue"), style({ foreground: "blue" }));
});

test("an unknown word is skipped rather than failing", () => {
  assert.deepEqual(parseStyle("bold sparkly"), style({ bold: true }));
});

test("a short hex colour is skipped", () => {
  assert.deepEqual(parseStyle("#f80"), style({}));
});

test("a named background is skipped", () => {
  assert.deepEqual(parseStyle("bg:red"), style({}));
});

test("an empty style sets nothing", () => {
  assert.deepEqual(parseStyle(""), style({}));
});

test("a named colour's hex form is the palette's", () => {
  assert.equal(hexColour("bright-red"), "#f14c4c");
});

test("a hex colour's hex form is itself", () => {
  assert.equal(hexColour("#ff8800"), "#ff8800");
});

test("no colour's hex form is empty", () => {
  assert.equal(hexColour(""), "");
});

test("SGR parameters are ordered bold, dim, italic, underline then colours", () => {
  assert.equal(sgr(style({ bold: true, italic: true, underline: true, dim: true, foreground: "red", background: "#102030" })), "1;2;3;4;31;48;2;16;32;48");
});

test("a bright named colour's SGR code is the palette's", () => {
  assert.equal(sgr(style({ foreground: "bright-black" })), "90");
});

test("a hex foreground's SGR parameters are 24-bit colour", () => {
  assert.equal(sgr(style({ foreground: "#ff8800" })), "38;2;255;136;0");
});

test("an empty style has no SGR parameters", () => {
  assert.equal(sgr(style({})), "");
});
