/**
 * A ready-made pretty logger: every event as a readable, coloured line, set up
 * in one line. It is the Node form of the event receiver Go's examples share.
 *
 *     3:04PM INFO create success source=core operation=create phase=success resource=resource.recording.one duration=1.2ms
 *       resource "recording" "one" {
 *         value = "a"
 *       }
 *
 * ```ts
 * const cfg = new Config({
 *   onEvent: prettylog.handler({ level: prettylog.levelFromEnv() }),
 *   eventData: EventDataLevel.Processed, // puts each created entity on its event
 * });
 * ```
 */

import { ConfigError, InvalidArgumentError, NotEncodableError, XclError } from "./errors.js";
import { EventDataLevel, type Event } from "./events.js";
import { plain, type Formatter, type Writer } from "./highlight/formatters.js";
import { Kind, type Token } from "./highlight/kinds.js";
import { forStream } from "./highlight/stream.js";
import { defaultTheme } from "./highlight/theme.js";
import { eventLink, type EventLink } from "./internal/event-link.js";
import { eventFields, eventLevel, eventMessage, type LogLevel } from "./internal/logbridge.js";
import { formatLine, formatRecord } from "./internal/prettyline.js";
import { render, StringWriter } from "./internal/render.js";
import type { LevelLogger } from "./events.js";
import { formatError } from "./print.js";

/** A log level: `"debug"`, `"info"`, `"warn"` or `"error"`, as Go's `slog` names them. */
export type { LogLevel };

/** The environment variable `levelFromEnv` reads, the one Go's example reads. */
export const LEVEL_ENV = "XCL_LOG_LEVEL";

/** What `handler` takes. */
export interface PrettyLogOptions {
  /** The stream written to, by default `process.stderr`. Give `out` or `logger`, not both. */
  out?: Writer;
  /** The minimum level, by default `"info"`. */
  level?: LogLevel;
  /** A logger to write through instead of a stream. */
  logger?: LevelLogger;
  /** Whether the logger takes fields then message, the default, or message then fields. */
  order?: "fields-first" | "message-first";
  /** The format, by default chosen from the stream with `forStream`, and plain through a logger. */
  formatter?: Formatter;
}

const RANKS: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

// what a run is told, once, when it shows no configuration because the
// configuration delivers events without resource data
const GUIDANCE = "configuration not shown: events carry no resource data";
const GUIDANCE_HINT = "create the configuration with eventData: EventDataLevel.Processed";

// the warning written for an entity whose configuration cannot be shown
const UNABLE = "unable to show configuration";

// the key the problems shown are counted under for an event built by hand
const NO_CONFIGURATION: object = {};

/**
 * The level named by `XCL_LOG_LEVEL`, as Go's `prettylog.LevelFromEnv` reads
 * it: `debug`, `info`, `warn` or `error`, in any letter case. Anything else, or
 * the variable unset, gives `info`. It is read only when this is called.
 */
export function levelFromEnv(): LogLevel {
  const named = (process.env[LEVEL_ENV] ?? "").toLowerCase();
  return Object.hasOwn(RANKS, named) ? (named as LogLevel) : "info";
}

/**
 * An `onEvent` handler writing every event at `level` or above as a readable
 * line: its time, level and message, then its source, operation, phase, entity
 * and any other attributes as `key=value`, with the source, operation and entity
 * highlighted.
 *
 * At info and below, beneath the line reporting an entity's creation it writes
 * the entity's configuration, with the values the provider filled in, rendered
 * from the event's saved record. That needs the configuration created with
 * `eventData: EventDataLevel.Processed`; without resource data, one line says how
 * to turn it on. An entity whose configuration cannot be shown gets one warning
 * line, and variables, outputs and modules are skipped silently. At every level,
 * beneath the line reporting a configuration mistake it writes the mistake's
 * report, once per problem.
 *
 * Colour is chosen from the stream with `forStream`, and `formatter` chooses
 * another format. With `logger` the lines go to that logger rather than a
 * stream, plain unless `formatter` says otherwise. A line and everything beneath
 * it go out in one write, and nothing waits on the stream, so a slow stream
 * cannot hold up an operation. The handler never rejects into an operation: a
 * failure to write is ignored. One handler may serve several configurations.
 */
export function handler(options: PrettyLogOptions = {}): (event: Event) => Promise<void> {
  if (options.out !== undefined && options.logger !== undefined) {
    throw new InvalidArgumentError("give out or logger, not both");
  }
  const level = options.level ?? "info";
  if (!Object.hasOwn(RANKS, level)) {
    throw new InvalidArgumentError(`level must be debug, info, warn or error, not ${JSON.stringify(level)}`);
  }
  const out = options.logger === undefined ? (options.out ?? process.stderr) : undefined;
  const formatter = options.formatter ?? (out === undefined ? plain : forStream(out));
  const prettyLog = new PrettyLog(out, level, options.logger, options.order ?? "fields-first", formatter);
  return (event) => prettyLog.handle(event);
}

/** What goes with a creation: the configuration beneath its line, a warning's error, and whether guidance is due. */
interface Configuration {
  block: string;
  warning?: string;
  guidance: boolean;
}

class PrettyLog {
  #guided = false;
  // how many problems each configuration's running operation has shown, by
  // configuration, so operations sharing the handler never hide or repeat each
  // other's reports
  readonly #shownProblems = new WeakMap<object, number>();

  constructor(
    private readonly out: Writer | undefined,
    private readonly level: LogLevel,
    private readonly logger: LevelLogger | undefined,
    private readonly order: "fields-first" | "message-first",
    private readonly formatter: Formatter,
  ) {}

  async handle(event: Event): Promise<void> {
    try {
      await this.#handle(event);
    } catch {
      // a receiver must never affect the operation
    }
  }

  async #handle(event: Event): Promise<void> {
    const link = eventLink(event);
    const key = link ?? NO_CONFIGURATION;
    if (startsOperation(event)) {
      // each operation counts the problems it has shown afresh, even when its
      // start line is below the level
      this.#shownProblems.delete(key);
    }
    const level = eventLevel(event);
    if (RANKS[level] < RANKS[this.level]) {
      return;
    }
    const line = formatLine(event, level, eventMessage(event), this.#style);

    let block = "";
    let warning: string | undefined;
    let guidance = false;
    if (RANKS[this.level] <= RANKS.info && event.operation === "create" && event.phase === "success") {
      ({ block, warning, guidance } = await this.#configuration(event, link));
    }
    const report = this.#report(event);
    if (report !== undefined && this.#reportWanted(event, key, report.problems)) {
      block += report.text;
    }
    if (guidance) {
      guidance = !this.#guided;
      this.#guided = true;
    }

    // one write per group: chunks on one stream keep their order, so a report
    // can never separate from its line
    this.#write(event, level, line + block);
    if (warning !== undefined) {
      this.#write(event, "warn", formatRecord(event.time, "warn", UNABLE, [["resource", event.resourceId], ["error", warning]], this.#style));
    }
    if (guidance) {
      this.#write(event, "info", formatRecord(event.time, "info", GUIDANCE, [["hint", GUIDANCE_HINT]], this.#style));
    }
  }

  async #configuration(event: Event, link: EventLink | undefined): Promise<Configuration> {
    if (event.data === undefined) {
      // no data is expected when the configuration was created without it, so
      // say once how to turn it on; an event built by hand shows nothing
      return { block: "", guidance: link !== undefined && link.eventData === EventDataLevel.None };
    }
    if (link === undefined) {
      return { block: "", warning: "the event was not delivered by a configuration", guidance: false };
    }
    let tokens: Token[];
    try {
      tokens = await link.savedEntityTokens(event.data);
    } catch (error) {
      if (error instanceof NotEncodableError) {
        // a variable, output or module is never written as configuration
        return { block: "", guidance: false };
      }
      return { block: "", warning: error instanceof Error ? error.message || error.name : String(error), guidance: false };
    }
    return { block: indent(render(tokens, this.formatter, defaultTheme, null)), guidance: false };
  }

  #report(event: Event): { text: string; problems: number } | undefined {
    const error = event.error;
    if (event.phase !== "error" || !(error instanceof XclError) || error.tokens.length === 0) {
      return undefined;
    }
    const problems = error instanceof ConfigError && error.problems.length > 0 ? error.problems.length : 1;
    return { text: indent(formatError(error, { formatter: this.formatter, theme: defaultTheme, width: 80 })), problems };
  }

  /**
   * Whether a report is written: each problem is reported once, beneath the
   * first line about it. A block's own error is always reported, and its
   * problems counted. The operation's closing error holds every problem again,
   * so its report is written only when it holds problems no earlier line showed.
   */
  #reportWanted(event: Event, key: object, problems: number): boolean {
    if (event.operation === "parse" || event.resourceId !== "") {
      this.#shownProblems.set(key, (this.#shownProblems.get(key) ?? 0) + problems);
      return true;
    }
    const shown = this.#shownProblems.get(key) ?? 0;
    this.#shownProblems.delete(key);
    return problems > shown;
  }

  /** `text` in `style`, written by the format as one piece of plain text styled by a one-entry theme. */
  readonly #style = (text: string, style: string): string => {
    if (style === "" || text === "") {
      return text;
    }
    const out = new StringWriter();
    this.formatter(out, { [Kind.Text]: style }, [{ kind: Kind.Text, text }]);
    return out.text;
  };

  #write(event: Event, level: LogLevel, text: string): void {
    if (this.logger !== undefined) {
      const message = text.replace(/\n+$/, "");
      if (this.order === "message-first") {
        this.logger[level](message, eventFields(event));
      } else {
        this.logger[level](eventFields(event), message);
      }
      return;
    }
    this.out?.write(text);
  }
}

/** Whether the event starts an operation, which begins a fresh count of the problems shown. */
function startsOperation(event: Event): boolean {
  return event.phase === "start" && event.resourceId === "" && event.operation !== "parse";
}

/** Every non-empty line of `text` moved right two spaces, ending in one line break, as Go's example indents. */
function indent(text: string): string {
  return `${text.replace(/\n+$/, "").split("\n").map((line) => (line === "" ? line : `  ${line}`)).join("\n")}\n`;
}
