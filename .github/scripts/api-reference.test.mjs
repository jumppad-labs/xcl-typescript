// Tests of api-reference.mjs against small packages written to a temporary
// directory, never the package's own source.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { generate } from "./api-reference.mjs";

const SCRIPT = fileURLToPath(new URL("./api-reference.mjs", import.meta.url));

const TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    lib: ["ES2023"],
    strict: true,
    types: [],
  },
  include: ["src/**/*.ts"],
};

/** A package in a new temporary directory, holding `files` below src/, removed when the test ends. */
function writePackage(t, files, version = "1.2.3") {
  const directory = mkdtempSync(join(tmpdir(), "api-reference-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "xcl-lang", version, type: "module" }));
  writeFileSync(join(directory, "tsconfig.json"), JSON.stringify(TSCONFIG));
  for (const [name, text] of Object.entries(files)) {
    const path = join(directory, "src", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return directory;
}

function runCheck(source) {
  return spawnSync(process.execPath, [SCRIPT, "--check", "--source", source], { encoding: "utf8" });
}

/** Every entry of the data, members included, by id. */
function entriesById(data) {
  const found = new Map();
  const visit = (entry) => {
    found.set(entry.id, entry);
    (entry.members ?? []).forEach(visit);
  };
  data.sections.forEach((section) => section.entries.forEach(visit));
  return found;
}

const DOCUMENTED_WIDGET = `
/** A widget. */
export class Widget {
  /** Spins the widget. */
  spin(): void {}
}
`;

test("the check fails, naming an undocumented public method", (t) => {
  const source = writePackage(t, {
    "index.ts": `
/** A widget. */
export class Widget {
  spin(): void {}
}
`,
  });

  const result = runCheck(source);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^xcl-lang\.Widget\.spin: no doc comment$/m);
});

test("the check passes on a package where every public name is documented", (t) => {
  const source = writePackage(t, { "index.ts": DOCUMENTED_WIDGET });

  const result = runCheck(source);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("an inherited member is listed on the class that inherits it", async (t) => {
  const source = writePackage(t, {
    "index.ts": `
/** The base. */
export class Base {
  /** Says hello. */
  hello(): string { return "hello"; }
}
/** The derived class. */
export class Derived extends Base {}
`,
  });

  const { data } = await generate(source);

  const inherited = entriesById(data).get("xcl-lang.Derived.hello");
  assert.notEqual(inherited, undefined);
  assert.equal(inherited.inheritedFrom, "xcl-lang.Base");
  assert.equal(inherited.description, "<p>Says hello.</p>");
});

test("an undocumented inherited member is reported once, on its defining class", async (t) => {
  const source = writePackage(t, {
    "index.ts": `
/** The base. */
export class Base {
  noDocs(): void {}
}
/** The derived class. */
export class Derived extends Base {}
`,
  });

  const { undocumented } = await generate(source);

  assert.deepEqual(undocumented, ["xcl-lang.Base.noDocs"]);
});

test("a name the entry point does not export is left out", async (t) => {
  const source = writePackage(t, {
    "index.ts": `export { Widget } from "./widget.js";\n`,
    "widget.ts": `${DOCUMENTED_WIDGET}\nexport class Hidden {\n  noDocs(): void {}\n}\n`,
  });

  const { data, undocumented } = await generate(source);

  assert.deepEqual([...entriesById(data).keys()], ["xcl-lang.Widget", "xcl-lang.Widget.constructor", "xcl-lang.Widget.spin"]);
  assert.deepEqual(undocumented, []);
});

test("internal, protected and private members are left out", async (t) => {
  const source = writePackage(t, {
    "index.ts": `
/** A widget. */
export class Widget {
  /** Spins the widget. */
  spin(): void {}
  /** @internal */
  internalOnly(): void {}
  protected guarded(): void {}
  private hidden(): void {}
  #secret = 1;
}
/** @internal */
export function helper(): void {}
`,
  });

  const { data, undocumented } = await generate(source);

  assert.deepEqual([...entriesById(data).keys()], ["xcl-lang.Widget", "xcl-lang.Widget.constructor", "xcl-lang.Widget.spin"]);
  assert.deepEqual(undocumented, []);
});

test("a @throws that names its error type with {@link} lists that type", async (t) => {
  const source = writePackage(t, {
    "index.ts": `
/** Thrown when it breaks. */
export class BrokenError extends Error {}
/**
 * Breaks.
 * @throws {@link BrokenError} always
 */
export function breakIt(): never { throw new BrokenError(); }
`,
  });

  const { data, problems } = await generate(source);

  assert.deepEqual(problems, []);
  assert.deepEqual(entriesById(data).get("xcl-lang.breakIt").raises, [{ type: "BrokenError", description: "<p>always</p>" }]);
});

test("a @throws with no {@link} fails, naming the function", async (t) => {
  const source = writePackage(t, {
    "index.ts": `
/** Thrown when it breaks. */
export class BrokenError extends Error {}
/**
 * Breaks.
 * @throws {BrokenError} always
 */
export function breakIt(): never { throw new BrokenError(); }
`,
  });

  const { problems } = await generate(source);

  assert.deepEqual(problems, ["xcl-lang.breakIt: @throws must name the error type as {@link Type}"]);
});

test("a value and a type exported under one name are one entry with both forms", async (t) => {
  const source = writePackage(t, {
    "index.ts": `
/** A shape. */
export type Shape = { readonly sides: number };
/** Makes a shape. */
export const Shape = (sides: number): Shape => ({ sides });
`,
  });

  const { data } = await generate(source);

  const entries = data.sections.flatMap((section) => section.entries).filter((entry) => entry.name === "Shape");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "xcl-lang.Shape");
  assert.equal(entries[0].kind, "type");
  assert.deepEqual(
    entries[0].overloads.map((overload) => overload.signature),
    ["type Shape = { readonly sides: number }", "Shape(sides: number): Shape"],
  );
});

test("every signature of an overloaded function is listed", async (t) => {
  const source = writePackage(t, {
    "index.ts": `
/** A number doubled. */
export function twice(value: number): number;
/** A string repeated. */
export function twice(value: string): string;
export function twice(value: number | string): number | string {
  return typeof value === "number" ? value * 2 : value + value;
}
`,
  });

  const { data } = await generate(source);

  const entry = entriesById(data).get("xcl-lang.twice");
  assert.deepEqual(
    entry.overloads.map((overload) => overload.signature),
    ["twice(value: number): number", "twice(value: string): string"],
  );
  assert.equal(entry.overloads[1].description, "<p>A string repeated.</p>");
});

test("a constructor type keeps new in its signature", async (t) => {
  const source = writePackage(t, {
    "index.ts": `
/** A class that can be constructed with no arguments. */
export type Constructor<T> = new () => T;
/** Builds things. */
export interface Factory {
  /** A new thing. */
  new (name: string): object;
}
`,
  });

  const { data } = await generate(source);

  const entries = entriesById(data);
  assert.equal(entries.get("xcl-lang.Constructor").signature, "type Constructor<T> = new () => T");
  assert.equal(entries.get("xcl-lang.Factory.constructor").signature, "new (name: string): object");
});

test("the data carries the package version, every entry and its members", async (t) => {
  const source = writePackage(
    t,
    {
      "index.ts": `
/** A widget. */
export class Widget {
  /** How fast it spins. */
  readonly speed: number = 1;
  /**
   * Spins the widget.
   * @param times how many turns
   * @returns the turns made
   */
  spin(times = 1): number { return times; }
}
`,
    },
    "4.5.6",
  );

  const { data } = await generate(source);

  assert.equal(data.schema, 1);
  assert.equal(data.language, "typescript");
  assert.equal(data.package, "xcl-lang");
  assert.equal(data.version, "4.5.6");
  const widget = entriesById(data).get("xcl-lang.Widget");
  assert.equal(widget.signature, "class Widget");
  assert.deepEqual(
    widget.members.map((member) => [member.id, member.kind]),
    [
      ["xcl-lang.Widget.constructor", "constructor"],
      ["xcl-lang.Widget.speed", "property"],
      ["xcl-lang.Widget.spin", "method"],
    ],
  );
  const spin = entriesById(data).get("xcl-lang.Widget.spin");
  assert.equal(spin.signature, "spin(times?: number): number");
  assert.deepEqual(spin.parameters, [{ name: "times", type: "number", default: "1", description: "<p>how many turns</p>" }]);
  assert.deepEqual(spin.returns, { type: "number", description: "<p>the turns made</p>" });
});

test("a {@link} to another entry becomes a link to its anchor", async (t) => {
  const source = writePackage(t, {
    "index.ts": `
/** A widget, spun by {@link spinAll}. */
export class Widget {}
/** Spins every widget. */
export function spinAll(): void {}
`,
  });

  const { data } = await generate(source);

  assert.equal(entriesById(data).get("xcl-lang.Widget").description, '<p>A widget, spun by <a href="#xcl-lang.spinAll"><code>spinAll</code></a>.</p>');
});
