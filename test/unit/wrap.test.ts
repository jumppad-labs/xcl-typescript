import assert from "node:assert/strict";
import { test } from "node:test";

import { plain } from "../../src/highlight/formatters.js";
import { Kind } from "../../src/highlight/kinds.js";
import { defaultTheme } from "../../src/highlight/theme.js";
import { render } from "../../src/internal/render.js";
import { wrapDetail } from "../../src/internal/wrap.js";

// Every expected string in the go-wordwrap cases below came from running Go's
// github.com/mitchellh/go-wordwrap v1.0.1 WrapString on the same input and width.

const SENTENCE = 'Blocks of type "timeout" are not expected here. Did you mean to define an argument called "timeout" instead, as an attribute with an equals sign?';

test("a sentence wraps at 80 as Go wraps it", () => {
  const expected = 'Blocks of type "timeout" are not expected here. Did you mean to define an\nargument called "timeout" instead, as an attribute with an equals sign?';

  assert.equal(wrapDetail(SENTENCE, 80), expected);
});

test("a sentence wraps at 40 as Go wraps it", () => {
  const expected = 'Blocks of type "timeout" are not\nexpected here. Did you mean to define an\nargument called "timeout" instead, as an\nattribute with an equals sign?';

  assert.equal(wrapDetail(SENTENCE, 40), expected);
});

test("a word longer than the width is left whole on its own line", () => {
  const text = "a short start then averyveryveryverylongwordthatisfarlongerthanthewidth and more";
  const expected = "a short start then\naveryveryveryverylongwordthatisfarlongerthanthewidth\nand more";

  assert.equal(wrapDetail(text, 20), expected);
});

test("runs of spaces are kept within a line", () => {
  const text = "one  two   three    four five six seven eight";
  const expected = "one  two\nthree\nfour five\nsix seven\neight";

  assert.equal(wrapDetail(text, 12), expected);
});

test("an existing line break is kept", () => {
  const text = "first line here\nsecond line is a bit longer than the width";
  const expected = "first line here\nsecond line is a bit\nlonger than the\nwidth";

  assert.equal(wrapDetail(text, 20), expected);
});

test("trailing spaces are kept", () => {
  const text = "words that end in spaces   ";
  const expected = "words that\nend in\nspaces   ";

  assert.equal(wrapDetail(text, 10), expected);
});

test("a tab is a space between words", () => {
  const text = "one\ttwo\tthree four five six";
  const expected = "one\ttwo\nthree four\nfive six";

  assert.equal(wrapDetail(text, 10), expected);
});

test("a no-break space is never broken at", () => {
  const text = "keep these words together and these apart";
  const expected = "keep these words together\nand these\napart";

  assert.equal(wrapDetail(text, 12), expected);
});

test("a word exactly the width fits", () => {
  const text = "abcde fghij";
  const expected = "abcde\nfghij";

  assert.equal(wrapDetail(text, 5), expected);
});

test("several line breaks and the spaces around them are handled as Go handles them", () => {
  const text = "a b c\n\nd e f   \n  g";
  const expected = "a b\nc\n\nd e\nf\n  g";

  assert.equal(wrapDetail(text, 3), expected);
});

test("emoji that fit by code points stay on one line although their UTF-16 length is over the width", () => {
  // 3 + 1 + 2 = 6 code points, but 11 UTF-16 units
  const text = "\u{1F600}\u{1F600}\u{1F600} \u{1F600}\u{1F600}";

  assert.equal(wrapDetail(text, 6), "\u{1F600}\u{1F600}\u{1F600} \u{1F600}\u{1F600}");
});

test("emoji break at the code point that passes the width", () => {
  // "a", a space and three emoji reach 5 code points; the fourth emoji passes
  // the width of 5 while the word of four is still shorter than the width
  const text = "a \u{1F600}\u{1F600}\u{1F600}\u{1F600}";

  assert.equal(wrapDetail(text, 5), "a\n\u{1F600}\u{1F600}\u{1F600}\u{1F600}");
});

test("a word of emoji exactly the width fits on its line", () => {
  // four code points at a width of 4, but 8 UTF-16 units
  const text = "\u{1F600}\u{1F600}\u{1F600}\u{1F600}";

  assert.equal(wrapDetail(text, 4), "\u{1F600}\u{1F600}\u{1F600}\u{1F600}");
});

test("accented letters count as one column each", () => {
  // 11 code points, 13 bytes in UTF-8
  const text = "héllo wörld";

  assert.equal(wrapDetail(text, 11), "héllo wörld");
});

test("a width of zero leaves the text unchanged", () => {
  assert.equal(wrapDetail(SENTENCE, 0), SENTENCE);
});

test("a width of null leaves the text unchanged", () => {
  assert.equal(wrapDetail(SENTENCE, null), SENTENCE);
});

test("a width of undefined leaves the text unchanged", () => {
  assert.equal(wrapDetail(SENTENCE, undefined), SENTENCE);
});

test("a negative width leaves the text unchanged", () => {
  assert.equal(wrapDetail(SENTENCE, -1), SENTENCE);
});

test("rendering wraps detail at a chosen width", () => {
  const tokens = [{ kind: Kind.Detail, text: SENTENCE }];

  const rendered = render(tokens, plain, defaultTheme, 40);

  assert.equal(rendered, 'Blocks of type "timeout" are not\nexpected here. Did you mean to define an\nargument called "timeout" instead, as an\nattribute with an equals sign?');
});

test("rendering at a chosen width leaves a source line whole", () => {
  const tokens = [{ kind: Kind.String, text: '"a quoted string longer than the width"' }];

  const rendered = render(tokens, plain, defaultTheme, 10);

  assert.equal(rendered, '"a quoted string longer than the width"');
});

test("rendering with a null width leaves detail unwrapped", () => {
  const tokens = [{ kind: Kind.Detail, text: SENTENCE }];

  const rendered = render(tokens, plain, defaultTheme, null);

  assert.equal(rendered, SENTENCE);
});

test("rendering with a width of zero leaves detail unwrapped", () => {
  const tokens = [{ kind: Kind.Detail, text: SENTENCE }];

  const rendered = render(tokens, plain, defaultTheme, 0);

  assert.equal(rendered, SENTENCE);
});
