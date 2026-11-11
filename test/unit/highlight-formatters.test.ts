import assert from "node:assert/strict";
import { test } from "node:test";

import { html, htmlInline, plain, svg, terminal, type Formatter } from "../../src/highlight/formatters.js";
import { Kind, type Token } from "../../src/highlight/kinds.js";
import { defaultTheme, type Theme } from "../../src/highlight/theme.js";

function render(format: Formatter, tokens: readonly Token[], theme: Theme = defaultTheme): string {
  let written = "";
  format({ write: (chunk) => (written += chunk) }, theme, tokens);
  return written;
}

function token(kind: number, text: string): Token {
  return { kind, text };
}

test("plain writes the text and ignores the default theme", () => {
  assert.equal(render(plain, [token(Kind.Attribute, "name"), token(Kind.Text, " = "), token(Kind.String, '"x"')]), 'name = "x"');
});

test("plain ignores any other theme", () => {
  assert.equal(render(plain, [token(Kind.Attribute, "name")], { [Kind.Attribute]: "bold red" }), "name");
});

test("terminal resets before every line break", () => {
  const output = render(terminal, [token(Kind.LineComment, "# one\n# two"), token(Kind.Text, "\n"), token(Kind.Attribute, "name")]);
  assert.equal(output.split("\n").length - 1, 2);
  assert.equal(output.split("\x1b[0m\n").length - 1, 2);
});

test("terminal colours a token over several lines one line at a time", () => {
  assert.equal(render(terminal, [token(Kind.String, "first\nsecond")]), "\x1b[33mfirst\x1b[0m\n\x1b[33msecond\x1b[0m");
});

test("terminal with its escape codes removed is the plain text", () => {
  const tokens = [token(Kind.BlockType, "resource"), token(Kind.Text, " "), token(Kind.String, '"container"'), token(Kind.Text, " {\n  "), token(Kind.Attribute, "image"), token(Kind.Text, " = "), token(Kind.Number, "42"), token(Kind.Text, "\n}\n")];
  // eslint-disable-next-line no-control-regex
  assert.equal(render(terminal, tokens).replace(/\x1b\[[0-9;]*m/g, ""), 'resource "container" {\n  image = 42\n}\n');
});

test("terminal writes an unknown kind in its category's style", () => {
  assert.equal(render(terminal, [token(1199, "note")]), "\x1b[3;90mnote\x1b[0m");
});

test("terminal ignores an unknown style word", () => {
  assert.equal(render(terminal, [token(Kind.Attribute, "name")], { ...defaultTheme, [Kind.Attribute]: "bold sparkly" }), "\x1b[1mname\x1b[0m");
});

test("terminal writes nothing for an empty token", () => {
  assert.equal(render(terminal, [token(Kind.Attribute, "")]), "");
});

test("html escapes special characters, with an apostrophe as &#39;", () => {
  assert.equal(render(html, [token(Kind.String, "<&\"'>")]), '<pre class="xcl"><span class="xcl-string">&lt;&amp;&quot;&#39;&gt;</span></pre>');
});

test("html has no style attribute", () => {
  assert.doesNotMatch(render(html, [token(Kind.Attribute, "name"), token(Kind.LineComment, " // note")]), /style=/);
});

test("html writes no span for plain text", () => {
  assert.equal(render(html, [token(Kind.Text, "a b")]), '<pre class="xcl">a b</pre>');
});

test("html puts the category's class first for a child kind", () => {
  assert.equal(render(html, [token(Kind.LineComment, "// note")]), '<pre class="xcl"><span class="xcl-comment xcl-line-comment">// note</span></pre>');
});

test("html gives an unknown kind its category's class", () => {
  assert.equal(render(html, [token(1199, "note")]), '<pre class="xcl"><span class="xcl-comment">note</span></pre>');
});

test("inline html writes a style attribute", () => {
  assert.equal(render(htmlInline, [token(Kind.Attribute, "name")]), '<pre><span style="color: #2472c8">name</span></pre>');
});

test("inline html has no class attribute", () => {
  assert.doesNotMatch(render(htmlInline, [token(Kind.Attribute, "name"), token(Kind.LineComment, " // note")]), /class=/);
});

test("inline html ignores an unknown style word", () => {
  assert.equal(render(htmlInline, [token(Kind.Attribute, "name")], { ...defaultTheme, [Kind.Attribute]: "bold sparkly" }), '<pre><span style="font-weight: bold">name</span></pre>');
});

test("svg writes one text element per line", () => {
  const output = render(svg, [token(Kind.Attribute, "first"), token(Kind.Text, "\n"), token(Kind.Attribute, "second"), token(Kind.Text, "\n"), token(Kind.Attribute, "third"), token(Kind.Text, "\n")]);
  assert.equal(output.split("<text ").length - 1, 3);
});

test("svg counts a character outside the basic plane as one column", () => {
  // Go counts runes: three characters are 8 + 8 + 3 * 6 wide, whatever their UTF-16 length
  assert.match(render(svg, [token(Kind.Text, "a\u{1F600}é")]), /viewBox="0 0 34 30"/);
});

test("svg escapes an apostrophe as &#39;", () => {
  assert.match(render(svg, [token(Kind.String, "it's")]), /it&#39;s/);
});

test("a format of the user's own is a function of the same type", () => {
  const bracketed: Formatter = (out, _theme, tokens) => {
    for (const piece of tokens) {
      out.write(`[${piece.text}]`);
    }
  };
  assert.equal(render(bracketed, [token(Kind.Attribute, "name"), token(Kind.Text, " = "), token(Kind.Number, "1")]), "[name][ = ][1]");
});

test("a format receives every token in one call", () => {
  const seen: number[] = [];
  const counting: Formatter = (_out, _theme, tokens) => {
    seen.push(tokens.length);
  };
  render(counting, [token(Kind.Attribute, "name"), token(Kind.Text, " = "), token(Kind.Number, "1")]);
  assert.deepEqual(seen, [3]);
});
