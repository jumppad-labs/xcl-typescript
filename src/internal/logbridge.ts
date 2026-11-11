/**
 * The rules of Go's `events.SlogHandler`, shared by `events.toLogger` and the
 * pretty logger, so the two write events at the same levels, with the same
 * messages and the same fields.
 */

import type { Event } from "../events.js";

/** A log level, as Go's `slog` names it. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

/** The level Go's bridge gives the event. */
export function eventLevel(event: Event): LogLevel {
  if (event.phase === "log") {
    const written = event.meta.level;
    return typeof written === "string" && LOG_LEVELS.has(written) ? (written as LogLevel) : "info";
  }
  if (event.phase === "error") {
    return "error";
  }
  if (event.phase === "blocked") {
    return "warn";
  }
  return "info";
}

/** The message Go's bridge gives the event: a log event's own, otherwise `<operation> <phase>`. */
export function eventMessage(event: Event): string {
  if (event.phase === "log") {
    const message = event.meta.message;
    return typeof message === "string" ? message : "";
  }
  return `${event.operation} ${event.phase}`;
}

/**
 * The event's details under Go's names and in Go's order: `source`,
 * `operation`, `phase`, `resource`, `type` and `file` when set, `duration` in
 * milliseconds when not zero, `error` when there is one, then each of the
 * event's details by key. The event itself is never a field.
 */
export function eventFields(event: Event): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
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
      fields[key] = value;
    }
  }
  if (event.duration !== 0) {
    fields.duration = event.duration;
  }
  if (event.error !== undefined) {
    fields.error = event.error;
  }
  for (const key of Object.keys(event.meta).sort()) {
    if (event.phase === "log" && (key === "level" || key === "message")) {
      continue;
    }
    if (!Object.hasOwn(fields, key)) {
      fields[key] = event.meta[key];
    }
  }
  return fields;
}
