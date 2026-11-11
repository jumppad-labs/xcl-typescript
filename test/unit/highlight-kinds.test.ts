import assert from "node:assert/strict";
import { test } from "node:test";

import { Kind, cssClassOf, goName, parentOf, tokensFromProto } from "../../src/highlight/kinds.js";
import { TokenKind } from "../../src/internal/core/xcl/core/v1/core_pb.js";

/** The protocol's name for an enum key: `BlockType` becomes `BLOCK_TYPE`. */
function protocolName(name: string): string {
  return name.replace(/[A-Z]/g, (letter, index: number) => (index === 0 ? "" : "_") + letter).toUpperCase();
}

test("every kind has the protocol's number and name", () => {
  for (const [name, value] of Object.entries(Kind)) {
    if (typeof value === "number") {
      assert.equal(TokenKind[protocolName(name) as keyof typeof TokenKind], value, name);
    }
  }
});

test("every protocol kind is a kind", () => {
  for (const [name, value] of Object.entries(TokenKind)) {
    if (typeof value === "number") {
      const known = Kind[value];
      assert.ok(known !== undefined, name);
      assert.equal(protocolName(known), name);
    }
  }
});

test("a child kind's parent is its category", () => {
  assert.equal(parentOf(Kind.LineComment), Kind.Comment);
});

test("a category's parent is itself", () => {
  assert.equal(parentOf(Kind.Comment), Kind.Comment);
});

test("text's parent is text", () => {
  assert.equal(parentOf(Kind.Text), Kind.Text);
});

test("an unknown kind's parent is its category", () => {
  assert.equal(parentOf(1199), 1100);
});

test("the class of a two-word kind is kebab case", () => {
  assert.equal(cssClassOf(Kind.BlockType), "xcl-block-type");
});

test("the class of a category is its own", () => {
  assert.equal(cssClassOf(Kind.Comment), "xcl-comment");
});

test("an unknown kind takes its category's class", () => {
  assert.equal(cssClassOf(1199), "xcl-comment");
});

test("an unknown kind in an unknown category has no class", () => {
  assert.equal(cssClassOf(9999), "");
});

test("Go's name for a known kind is its enum name", () => {
  assert.equal(goName(Kind.BlockType), "BlockType");
});

test("Go's name for an unknown kind names its number", () => {
  assert.equal(goName(1199), "Kind(1199)");
});

test("protocol tokens keep their order and text", () => {
  assert.deepEqual(
    tokensFromProto([
      { kind: Kind.Attribute, text: "image" },
      { kind: Kind.Text, text: " = " },
      { kind: Kind.String, text: '"nginx"' },
    ]),
    [
      { kind: Kind.Attribute, text: "image" },
      { kind: Kind.Text, text: " = " },
      { kind: Kind.String, text: '"nginx"' },
    ],
  );
});

test("a protocol token of an unknown kind keeps its number", () => {
  assert.deepEqual(tokensFromProto([{ kind: 1199, text: "// later" }]), [{ kind: 1199, text: "// later" }]);
});
