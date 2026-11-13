/**
 * One event as the line Go's example pretty logger writes for it.
 *
 * Go's `example/prettylog` writes events through `events.SlogHandler` into
 * charmbracelet/log with its text format and the Kitchen time. This ports that
 * layout, so a Node run reads exactly as a Go run does:
 *
 *     3:04PM INFO create success source=core operation=create phase=success resource=resource.recording.one
 *
 * It is pure: no I/O and no engine. Every styled piece goes through a callback
 * the caller supplies, with a style string from `STYLES`, so the layout itself
 * never writes an escape code.
 */

import type { Event } from "../events.js";
import type { LogLevel } from "./logbridge.js";

/** Styles a piece of text: returns the text as written, plain or coloured. */
export type Styler = (text: string, style: string) => string;

/** The styler of plain text: every piece unchanged. */
export const noStyle: Styler = (text) => text;

/** The style string of each styled part of a line; the time, the message and other values are unstyled. */
export const STYLES: Readonly<Record<string, string>> = {
  // the level labels, bold as charmbracelet's, in the nearest of the 16 named
  // colours to its 63, 86, 192 and 204
  DEBU: "bold blue",
  INFO: "bold cyan",
  WARN: "bold yellow",
  ERRO: "bold red",
  // keys and the separators are faint, as charmbracelet's defaults
  key: "dim",
  separator: "dim",
  // the keys that say where an event came from and what it is about
  "key.source": "magenta",
  "value.source": "bold magenta",
  "key.resource": "cyan",
  "value.resource": "bold cyan",
  "key.operation": "yellow",
  "value.operation": "bold yellow",
};

/** What charmbracelet writes before each line of a multi-line value. */
const INDENT_SEPARATOR = "  │ ";

/** One attribute of a line: its key and value. */
export type Attribute = readonly [key: string, value: unknown];

/** `time` in local time in Go's `time.Kitchen` form, such as `3:04PM`. */
export function kitchen(time: Date): string {
  const hours = time.getHours();
  return `${hours % 12 || 12}:${String(time.getMinutes()).padStart(2, "0")}${hours < 12 ? "AM" : "PM"}`;
}

/** The four-letter label charmbracelet writes for a level. */
export function levelLabel(level: LogLevel): string {
  switch (level) {
    case "error":
      return "ERRO";
    case "warn":
      return "WARN";
    case "info":
      return "INFO";
    default:
      return "DEBU";
  }
}

/** The event's attributes in the order Go's `events.SlogHandler` writes them, each set one only. */
export function attributes(event: Event): Attribute[] {
  const found: Attribute[] = [];
  const named: readonly (readonly [string, string])[] = [
    ["source", event.source],
    ["operation", event.operation],
    ["phase", event.phase],
    ["resource", event.resourceId],
    ["type", event.resourceType],
    ["file", event.file],
  ];
  for (const [key, value] of named) {
    if (value !== "") {
      found.push([key, value]);
    }
  }
  if (event.duration !== 0) {
    found.push(["duration", goDuration(event.duration)]);
  }
  if (event.error !== undefined) {
    found.push(["error", event.error.message]);
  }
  for (const key of Object.keys(event.meta).sort()) {
    if (event.phase === "log" && (key === "level" || key === "message")) {
      continue;
    }
    found.push([key, event.meta[key]]);
  }
  return found;
}

/** The line Go's example writes for `event` at `level` with `message`, ending in a line break. */
export function formatLine(event: Event, level: LogLevel, message: string, style: Styler = noStyle): string {
  return formatRecord(event.time, level, message, attributes(event), style);
}

/** A line in charmbracelet's text layout from its parts, for lines that are not an event's own, such as a warning. */
export function formatRecord(time: Date, level: LogLevel, message: string, attrs: readonly Attribute[], style: Styler = noStyle): string {
  const label = levelLabel(level);
  let out = `${kitchen(time)} ${style(label, STYLES[label] as string)}`;
  if (message !== "") {
    out += ` ${message}`;
  }
  const separator = style("=", STYLES.separator as string);
  attrs.forEach(([name, value], index) => {
    const more = index < attrs.length - 1;
    let text = goValue(value);
    const raw = text === "";
    if (raw) {
      text = '""';
    }
    const key = style(name, STYLES[`key.${name}`] ?? (STYLES.key as string));
    const valueStyle = STYLES[`value.${name}`] ?? "";
    if (text.includes("\n")) {
      out += `\n  ${key}${separator}\n`;
      out += indented(text, style(INDENT_SEPARATOR, STYLES.separator as string), more, valueStyle, style);
    } else if (!raw && needsQuoting(text)) {
      out += ` ${key}${separator}${style(`"${escape(text, true)}"`, valueStyle)}`;
    } else {
      out += ` ${key}${separator}${style(text, valueStyle)}`;
    }
  });
  return `${out}\n`;
}

/**
 * A multi-line value, one indented line per line, as charmbracelet's
 * `writeIndent` writes it: every line but the last in the plain value style, the
 * last in the key's own value style, and a line break after the last only when
 * more attributes follow.
 */
function indented(text: string, indent: string, newline: boolean, valueStyle: string, style: Styler): string {
  let out = "";
  let rest = text;
  for (;;) {
    const at = rest.indexOf("\n");
    if (at === -1) {
      if (rest !== "") {
        out += indent + style(escape(rest, false), valueStyle);
        if (newline) {
          out += "\n";
        }
      }
      return out;
    }
    out += `${indent}${style(escape(rest.slice(0, at), false), "")}\n`;
    rest = rest.slice(at + 1);
  }
}

/**
 * `value`, decoded from JSON or an event field, as Go's `fmt` writes it through
 * slog. JavaScript has one number type, so a whole number within the safe
 * integer range is written as an integer, the common case, where Go's float form
 * would write one million as `1e+06`; any other number is written as Go writes
 * a float.
 */
export function goValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (value === null || value === undefined) {
    return "<nil>";
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? String(value) : goFloat(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(goValue).join(" ")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `map[${Object.keys(object).sort().map((key) => `${key}:${goValue(object[key])}`).join(" ")}]`;
  }
  return String(value);
}

/**
 * A float as Go's `%v` writes it: the shortest digits that read back as the
 * same float, in exponent form when the exponent is below -4 or at least 6,
 * with at least two exponent digits, and otherwise in the plain form.
 */
export function goFloat(value: number): string {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? "+Inf" : "-Inf";
  }
  if (value === 0) {
    return Object.is(value, -0) ? "-0" : "0";
  }
  const [mantissa, exponent] = Math.abs(value).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const first = Number(exponent);
  const point = first + 1;
  const prefix = value < 0 ? "-" : "";
  if (first < -4 || first >= 6) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
    return `${prefix}${digits[0]}${fraction}e${first < 0 ? "-" : "+"}${String(Math.abs(first)).padStart(2, "0")}`;
  }
  if (point <= 0) {
    return `${prefix}0.${"0".repeat(-point)}${digits}`;
  }
  if (point >= digits.length) {
    return prefix + digits + "0".repeat(point - digits.length);
  }
  return `${prefix}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** A duration given in milliseconds, as Go's `time.Duration.String` writes it, such as `1.5ms` or `1m1s`. */
export function goDuration(milliseconds: number): string {
  const nanoseconds = Math.round(milliseconds * 1_000_000);
  const negative = nanoseconds < 0;
  let u = Math.abs(nanoseconds);
  if (u === 0) {
    return "0s";
  }
  let text: string;
  if (u < 1_000_000_000) {
    // under a second, the largest unit that keeps a whole part
    const [unit, precision] = u < 1000 ? (["ns", 0] as const) : u < 1_000_000 ? (["µs", 3] as const) : (["ms", 6] as const);
    const [fractionText, whole] = fraction(u, precision);
    text = `${whole}${fractionText}${unit}`;
  } else {
    const [fractionText, whole] = fraction(u, 9);
    u = whole;
    text = `${u % 60}${fractionText}s`;
    u = Math.floor(u / 60);
    if (u > 0) {
      text = `${u % 60}m${text}`;
      u = Math.floor(u / 60);
      if (u > 0) {
        text = `${u}h${text}`;
      }
    }
  }
  return negative ? `-${text}` : text;
}

/** Go's `fmtFrac`: the fraction of `value / 10**precision` without trailing zeros, and the whole part. */
function fraction(value: number, precision: number): readonly [string, number] {
  let rest = value;
  let digits = "";
  let printed = false;
  for (let index = 0; index < precision; index += 1) {
    const digit = rest % 10;
    printed = printed || digit !== 0;
    if (printed) {
      digits = String(digit) + digits;
    }
    rest = Math.floor(rest / 10);
  }
  return [printed ? `.${digits}` : "", rest];
}

/** Go's `unicode.IsPrint`: letters, marks, numbers, punctuation, symbols and the ASCII space. */
function printable(char: string): boolean {
  return char === " " || /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u.test(char);
}

/** Whether charmbracelet quotes a value: it holds `"`, `=`, a space or a character that does not print. */
function needsQuoting(text: string): boolean {
  for (const char of text) {
    if (char === '"' || char === "=" || char === " " || char === "�" || !printable(char)) {
      return true;
    }
  }
  return false;
}

const ESCAPES: Readonly<Record<string, string>> = { "\x07": "\\a", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\v": "\\v" };

/** Characters that do not print written as Go escapes, and `"` as `\"` when `quotes`, as `escapeStringForOutput`. */
function escape(text: string, quotes: boolean): string {
  let out = "";
  for (const char of text) {
    if (quotes && char === '"') {
      out += '\\"';
    } else if (printable(char)) {
      out += char;
    } else if (ESCAPES[char] !== undefined) {
      out += ESCAPES[char];
    } else {
      const code = char.codePointAt(0) as number;
      if (code < 0x20) {
        out += `\\x${code.toString(16).padStart(2, "0")}`;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        // a lone surrogate is not a valid rune; Go writes the replacement character
        out += "\\ufffd";
      } else if (code < 0x10000) {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
      } else {
        out += `\\U${code.toString(16).padStart(8, "0")}`;
      }
    }
  }
  return out;
}
