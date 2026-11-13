/** Events: what the engine reports as an operation runs. */

import type { MessageShape } from "@bufbuild/protobuf";

import type { EntityClass } from "./decorators.js";
import { fromProto, type XclError } from "./errors.js";
import { hydrate, parseRecord, typedEntity, type ClassMap } from "./hydrate.js";
import { EventDataLevel as EventDataLevelMessage, type EventSchema } from "./internal/core/xcl/core/v1/core_pb.js";
import { eventFields, eventLevel, eventMessage } from "./internal/logbridge.js";

/** What resource data lifecycle events carry. */
export const EventDataLevel = {
  /** No resource data on any event. The default. */
  None: "none",
  /** The resource as it was before the provider was called, on every lifecycle event. */
  Raw: "raw",
  /** On a success event, the resource as xcl records it in state, including values the provider filled in. */
  Processed: "processed",
} as const;

/** A level of event data. */
export type EventDataLevel = (typeof EventDataLevel)[keyof typeof EventDataLevel];

/** The message form of a level. @internal */
export function eventDataLevelMessage(level: EventDataLevel): EventDataLevelMessage {
  switch (level) {
    case EventDataLevel.Raw:
      return EventDataLevelMessage.EVENT_DATA_RAW;
    case EventDataLevel.Processed:
      return EventDataLevelMessage.EVENT_DATA_PROCESSED;
    default:
      return EventDataLevelMessage.EVENT_DATA_NONE;
  }
}

/** One event of an operation, delivered to the configuration's `onEvent` handler. */
export class Event {
  /** When it happened. */
  readonly time: Date;
  /** `core`, or the name of the plugin that reported it. */
  readonly source: string;
  /** What was happening, such as `apply` or `create`. */
  readonly operation: string;
  /** How far it had got, such as `start` or `success`. */
  readonly phase: string;
  /** The type of the entity it concerns. */
  readonly resourceType: string;
  /** The address of the entity it concerns. */
  readonly resourceId: string;
  /** The file the entity is declared in. */
  readonly file: string;
  /** How long the step took, in milliseconds. */
  readonly duration: number;
  /** The error of a failed step. */
  readonly error: XclError | undefined;
  /** The entity's saved record as JSON, masked by the event mask, or undefined when the event carries none. */
  readonly data: Uint8Array | undefined;
  /** The details of a log message. */
  readonly meta: Readonly<Record<string, unknown>>;
  readonly #classes: ClassMap;

  /** An event from the engine's message. @internal */
  constructor(message: MessageShape<typeof EventSchema>, classes: ClassMap) {
    this.time = new Date(Number(message.timeUnixNano / 1_000_000n));
    this.source = message.source;
    this.operation = message.operation;
    this.phase = message.phase;
    this.resourceType = message.resourceType;
    this.resourceId = message.resourceId;
    this.file = message.file;
    this.duration = Number(message.durationNano) / 1_000_000;
    this.error = message.error === undefined ? undefined : fromProto(message.error);
    this.data = message.data.length > 0 ? message.data : undefined;
    this.meta = metaOf(message.metaJson);
    this.#classes = classes;
  }

  /**
   * The entity the event's data holds, or undefined when the event carries no
   * data. With a class it is an instance of that class; otherwise the class
   * registered for its type, or a generic `Entity`.
   */
  entity<T extends object>(type: EntityClass<T>): T | undefined;
  entity(): object | undefined;
  entity(type?: EntityClass): object | undefined {
    if (this.data === undefined) {
      return undefined;
    }
    const record = parseRecord(this.data);
    return type === undefined ? hydrate(record, this.#classes) : typedEntity(record, type, this.#classes);
  }

  /** A log message's level, or an empty string. */
  get level(): string {
    return String(this.meta.level ?? "");
  }

  /** A log message's text, or an empty string. */
  get message(): string {
    return String(this.meta.message ?? "");
  }
}

function metaOf(json: Uint8Array): Record<string, unknown> {
  if (json.length === 0) {
    return {};
  }
  const text = new TextDecoder().decode(json);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

/**
 * Any logger with the four level methods, such as pino, winston or the
 * console. Each method takes the fields and the message in the order the
 * logger expects.
 */
export interface LevelLogger {
  /** Writes at debug. */
  debug(...args: unknown[]): unknown;
  /** Writes at info. */
  info(...args: unknown[]): unknown;
  /** Writes at warn. */
  warn(...args: unknown[]): unknown;
  /** Writes at error. */
  error(...args: unknown[]): unknown;
}

/** What `toLogger` takes. */
export interface ToLoggerOptions {
  /** Whether the logger takes fields then message, as pino does and the default, or message then fields, as winston does. */
  order?: "fields-first" | "message-first";
}

/**
 * An `onEvent` handler writing each event to `logger` as Go's
 * `events.SlogHandler` writes it to slog. A log event is written at its own
 * level with its own message; every other event as `<operation> <phase>`, at
 * error for phase `error`, warn for `blocked` and info otherwise. The fields
 * carry Go's names: `source`, `operation`, `phase`, `resource`, `type`, `file`,
 * `duration` (in milliseconds), `error`, then the event's details by key.
 *
 * ```ts
 * const cfg = new Config({ onEvent: events.toLogger(pino()) });
 * const other = new Config({ onEvent: events.toLogger(winstonLogger, { order: "message-first" }) });
 * ```
 */
export function toLogger(logger: LevelLogger, options: ToLoggerOptions = {}): (event: Event) => void {
  const messageFirst = options.order === "message-first";
  return (event) => {
    const level = eventLevel(event);
    const message = eventMessage(event);
    const fields = eventFields(event);
    if (messageFirst) {
      logger[level](message, fields);
    } else {
      logger[level](fields, message);
    }
  };
}
