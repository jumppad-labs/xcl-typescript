/** Token kinds and labelled text, mirrored by hand from the protocol's `TokenKind`. */

/**
 * What a piece of labelled text is, numbered as the protocol numbers it.
 *
 * Kinds are numbered in blocks of 100. A kind's category is
 * `Math.floor(kind / 100) * 100`, so a theme that styles `Kind.Comment` covers
 * every comment, and a kind a newer engine sends that this package does not
 * know still falls back to its category.
 */
export enum Kind {
  /** Unlabelled text, such as spaces and line breaks. */
  Text = 0,

  /** A block's header. */
  Block = 100,
  /** A block's type. */
  BlockType = 101,
  /** The type of a nested block. */
  NestedBlock = 102,

  /** A block's labels. */
  Label = 200,
  /** A block's subtype. */
  TypeLabel = 201,
  /** A block's name. */
  NameLabel = 202,

  /** An attribute's name. */
  Attribute = 300,

  /** A string. */
  String = 400,
  /** An escape inside a string. */
  StringEscape = 401,
  /** A heredoc's text. */
  Heredoc = 402,
  /** A heredoc's marker. */
  HeredocMarker = 403,
  /** A heredoc's `<<` or `<<-`. */
  HeredocOperator = 404,

  /** A number. */
  Number = 500,

  /** `true`, `false` and `null`. */
  Constant = 600,

  /** A function call's name. */
  Function = 700,
  /** A built-in function call's name. */
  BuiltinFunction = 701,

  /** A reference to another entity. */
  Reference = 800,
  /** A member of a reference. */
  Member = 801,

  /** An operator. */
  Operator = 900,

  /** Punctuation. */
  Punctuation = 1000,
  /** The start of an interpolation. */
  InterpolationBegin = 1001,
  /** The end of an interpolation. */
  InterpolationEnd = 1002,
  /** A template directive. */
  TemplateDirective = 1003,
  /** An accessor. */
  Accessor = 1004,

  /** A comment. */
  Comment = 1100,
  /** A `//` comment. */
  LineComment = 1101,
  /** A `#` comment. */
  HashComment = 1102,
  /** A block comment. */
  BlockComment = 1103,

  /** A change summary's markers. */
  Diff = 1200,
  /** Something a change would insert. */
  Inserted = 1201,
  /** Something a change would delete. */
  Deleted = 1202,
  /** Something a change would alter. */
  Changed = 1203,

  /** The faulty span of a problem. */
  Problem = 1300,
  /** The faulty span of an error. */
  Error = 1301,
  /** The faulty span of a warning. */
  Warning = 1302,

  /** A report's parts. */
  Report = 1400,
  /** A report's summary. */
  Summary = 1401,
  /** A report's location. */
  Location = 1402,
  /** A report's line-number gutter. */
  Gutter = 1403,
  /** A report's detail. */
  Detail = 1404,
}

/**
 * One piece of labelled text. `kind` is a `Kind`, or a number this package does
 * not know. The texts of a list of tokens, joined in order, are the whole
 * output, every byte of it.
 */
export interface Token {
  /** What the text is: a `Kind`, or a number this package does not know. */
  readonly kind: number;
  /** The text. */
  readonly text: string;
}

/** The category of any kind number, known or not. */
export function parentOf(kind: number): number {
  return Math.floor(kind / 100) * 100;
}

/** The enum name of a kind this package knows, or undefined. @internal */
function nameOf(kind: number): string | undefined {
  return Kind[kind];
}

/** Whether this package knows the kind number. @internal */
export function isKnown(kind: number): boolean {
  return nameOf(kind) !== undefined;
}

/** The kinds this package knows, in ascending order. @internal */
export function knownKinds(): number[] {
  return Object.values(Kind)
    .filter((value): value is number => typeof value === "number")
    .sort((left, right) => left - right);
}

function classOfName(name: string): string {
  return "xcl-" + name.replace(/[A-Z]/g, (letter, index: number) => (index === 0 ? "" : "-") + letter.toLowerCase());
}

/**
 * The HTML class of any kind number, the same in every language: a known kind's
 * own, else its known category's, else an empty string.
 */
export function cssClassOf(kind: number): string {
  const name = nameOf(kind);
  if (name !== undefined) {
    return classOfName(name);
  }
  const parent = nameOf(parentOf(kind));
  return parent === undefined ? "" : classOfName(parent);
}

/** The name Go gives a kind, such as `BlockType`, or `Kind(1199)` for one it does not know. @internal */
export function goName(kind: number): string {
  return nameOf(kind) ?? `Kind(${kind})`;
}

/** Protocol tokens as `Token` values, in order, keeping a kind this package does not know as its number. @internal */
export function tokensFromProto(tokens: readonly { readonly kind: number; readonly text: string }[]): Token[] {
  return tokens.map((token) => ({ kind: token.kind, text: token.text }));
}
