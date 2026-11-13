/**
 * The Node parity program: the counterpart of xcl's `cmd/parity`.
 *
 * It runs one parity fixture through the TypeScript API and writes the same
 * normalised JSON record the Go program writes, so the two can be compared:
 *
 *     node run.js --fixture <dir> --plugins <dir> --out <file>
 *
 * The record covers, in order: validate, diff before the apply, apply, entities
 * and outputs after it, the state written, the configuration text of every
 * entity under each combination of the encode choices, the diff of the changed
 * configuration when the fixture has one, entities after a load in a new
 * process, and destroy. Temporary paths are replaced by `<tmp>` and the fixture
 * directory by `<fixture>`.
 *
 * The record also holds what a person is shown: the report `formatError` gives
 * for the validate and apply errors (`printed_validate`, `printed_apply`), the
 * text `printEntity` prints for every entity with its computed values
 * (`printed_entities`), the change summaries `printDiff` prints
 * (`printed_diff_before`, `printed_diff_changed`), every event written through
 * `events.toLogger` (`log`), and, for a fixture whose apply succeeds, what the
 * pretty logger writes for a fresh apply at info (`pretty_log`).
 *
 * Go's record is snake_case, as the engine writes it. Entities come from the
 * engine's JSON as it was sent, the diff from `Diff.raw`, and outputs from
 * `Config.outputs()` with the last segment of each address put back into
 * snake_case with `toSnake`, so the public lookup is what is compared.
 *
 * With `--load`, which the program runs itself with for the load stage, it
 * loads the state in `--state` with the fixture's types and prints the
 * entities.
 *
 * With `--typed-lookups`, the `looked_up` texts of the encode section come from
 * an instance of the entity's registered class, `find(Class, address)`, rather
 * than the generic entity `find(address)` returns, wherever a class is
 * registered. The record is otherwise the same, and must still equal Go's.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { entityNameOf } from "../../src/decorators.js";
import { GenericEntity, sourceOf, toSnake } from "../../src/hydrate.js";
import {
  Config,
  EventDataLevel,
  events,
  formatError,
  LocalRegistry,
  prettylog,
  printDiff,
  XclError,
  type ConfigOptions,
  type Diff,
  type EncodeOptions,
  type EntityClass,
  type LevelLogger,
} from "../../src/index.js";
import { FIXTURES, HAND_BUILT, ParityFunctions } from "./types.js";

type JsonObject = Record<string, unknown>;

const EXECUTABLE_SUFFIX = process.platform === "win32" ? ".exe" : "";

/** The file name of the recording fixture plugin binary under `--plugins`. */
const RECORDING_PLUGIN_NAME = `xcl-plugin-recording${EXECUTABLE_SUFFIX}`;

/** The root of this package's checkout; this file compiles to `build/test/test/parity/run.js`. */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const runExecutable = promisify(execFile);

/** The directory of the parity fixtures: in `XCL_SRC`, or the sibling `xcl` checkout by default. */
export function parityFixturesDirectory(): string {
  return join(resolve(ROOT, process.env.XCL_SRC || "../xcl"), "bindings", "libxcl", "testdata", "parity");
}

/** A fixture directory, read. */
interface Fixture {
  dir: string;
  name: string;
  main: string;
  changed: string | undefined;
  variables: JsonObject;
  /** The addresses of the entities built by hand for the encode stage. */
  handBuilt: string[];
}

function readFixture(directory: string): Fixture {
  const dir = resolve(directory);
  const name = basename(dir);
  const main = join(dir, "main.xcl");
  if (!existsSync(main)) {
    throw new Error(`fixture ${directory} has no main.xcl`);
  }
  if (FIXTURES[name] === undefined) {
    throw new Error(`fixture ${name} has no classes in test/parity/types.ts`);
  }

  const changed = join(dir, "changed", "main.xcl");
  const variablesPath = join(dir, "variables.json");
  const handBuiltPath = join(dir, "hand_built.json");

  return {
    dir,
    name,
    main,
    changed: existsSync(changed) ? changed : undefined,
    variables: existsSync(variablesPath) ? (JSON.parse(readFileSync(variablesPath, "utf8")) as JsonObject) : {},
    handBuilt: existsSync(handBuiltPath) ? (JSON.parse(readFileSync(handBuiltPath, "utf8")) as string[]) : [],
  };
}

/** The Config a fixture runs with, exactly as the Go program builds it. */
async function newConfig(fixture: Fixture, plugins: string, stateDir: string, tmp: string, extra: Pick<ConfigOptions, "onEvent" | "eventData"> = {}): Promise<Config> {
  const local = new LocalRegistry();
  local.register(...(FIXTURES[fixture.name] as readonly EntityClass[]));
  local.registerFunctions(new ParityFunctions());

  if (plugins !== "") {
    local.registerExternalPlugin(join(plugins, RECORDING_PLUGIN_NAME));
  }

  const variables: JsonObject = {};
  for (const [key, value] of Object.entries(fixture.variables)) {
    variables[key] = typeof value === "string" ? value.replaceAll("<tmp>", tmp) : value;
  }

  return new Config({ registries: [local], statePath: stateDir, variables, ...extra }).setup();
}

/** One record written through the logging bridge: its level, message, resource and operation. */
export interface LogEntry {
  level: string;
  message: string;
  resource: string;
  operation: string;
}

/** A logger with the four level methods that keeps every record, as the Go program's logRecorder does. */
class LogRecorder implements LevelLogger {
  readonly entries: LogEntry[] = [];

  #record(level: string, fields: unknown, message: unknown): void {
    const named = fields as Record<string, unknown>;
    this.entries.push({ level, message: String(message), resource: String(named.resource ?? ""), operation: String(named.operation ?? "") });
  }

  debug(fields: unknown, message: unknown): void {
    this.#record("debug", fields, message);
  }

  info(fields: unknown, message: unknown): void {
    this.#record("info", fields, message);
  }

  warn(fields: unknown, message: unknown): void {
    this.#record("warn", fields, message);
  }

  error(fields: unknown, message: unknown): void {
    this.#record("error", fields, message);
  }
}

/** A writer collecting what is written to it. */
function collector(): { text: string; write(chunk: string): void } {
  return {
    text: "",
    write(chunk: string): void {
      this.text += chunk;
    },
  };
}

/** Calls `operation` and gives what it returned, or the engine error it threw. */
async function attempt<T>(operation: () => Promise<T>): Promise<[T | undefined, XclError | undefined]> {
  try {
    return [await operation(), undefined];
  } catch (error) {
    if (error instanceof XclError) {
      return [undefined, error];
    }
    throw error;
  }
}

/**
 * Every entity as the engine rendered it: a generic entity holds the JSON, and
 * an instance of a registered class remembers the JSON it was hydrated from.
 */
async function rawEntities(config: Config): Promise<JsonObject[]> {
  const entities = await config.entities();
  return entities.map((entity) => {
    if (entity instanceof GenericEntity) {
      return entity.toJSON();
    }
    const source = sourceOf(entity);
    if (source === undefined) {
      throw new Error(`entities returned a ${entity.constructor.name} that was not hydrated from the engine's JSON`);
    }
    return source;
  });
}

/** Outputs keyed as Go keys them: `outputs()` gives the last segment in camelCase, which is put back. */
async function snakeCaseOutputs(config: Config): Promise<JsonObject> {
  const outputs = await config.outputs();
  return Object.fromEntries(
    Object.entries(outputs).map(([address, value]) => {
      const dot = address.lastIndexOf(".");
      return [address.slice(0, dot + 1) + toSnake(address.slice(dot + 1)), value];
    }),
  );
}

export interface RunOptions {
  /** Encode the `looked_up` texts from registered classes rather than generic entities. */
  typedLookups: boolean;
}

/** Runs every stage of a fixture and returns the record. */
export async function run(fixtureDir: string, plugins: string, options: RunOptions): Promise<JsonObject> {
  const fixture = readFixture(fixtureDir);

  const tmp = mkdtempSync(join(tmpdir(), "xcl-parity-"));
  let config: Config | undefined;
  try {
    // the plugin registry caches under HOME; the engine starts with the first
    // Config and inherits the environment then
    process.env.HOME = join(tmp, "home");

    const stateDir = join(tmp, "state");
    const n = new Normaliser({ tmp, fixture: fixture.dir });
    const record: JsonObject = {};

    // every event the configuration emits is written through the package's
    // logging bridge to a logger that keeps each record, at every level
    const logs = new LogRecorder();

    config = await newConfig(fixture, plugins, stateDir, tmp, { onEvent: events.toLogger(logs) });
    const opened = config;

    const [, validateError] = await attempt(() => opened.validate(fixture.main));
    record.validate = n.outcome(validateError);
    record.printed_validate = n.printedError(validateError);

    const [before, beforeError] = await attempt(() => opened.diff(fixture.main));
    record.diff_before = n.diff(before, beforeError);
    record.printed_diff_before = n.printedDiff(before, beforeError);

    const [, applyError] = await attempt(() => opened.apply(fixture.main));
    record.apply = n.outcome(applyError);
    record.printed_apply = n.printedError(applyError);
    record.entities = n.entities(await rawEntities(config));
    record.outputs = n.value(await snakeCaseOutputs(config));
    record.state = n.state(stateDir);
    record.encode = await encodeSection(config, fixture, stateDir, n, options);
    record.printed_entities = await printedEntitiesSection(config, n);

    if (fixture.changed !== undefined) {
      const changedPath = fixture.changed;
      const [changed, changedError] = await attempt(() => opened.diff(changedPath));
      record.diff_changed = n.diff(changed, changedError);
      record.printed_diff_changed = n.printedDiff(changed, changedError);
    }

    record.log = n.log(logs.entries);

    // Go's example writes no report beneath an error and no guidance, so only
    // a fixture whose apply succeeds is compared
    record.pretty_log = null;
    if (applyError === undefined) {
      record.pretty_log = await prettyLog(fixture, plugins, tmp, n);
    }

    if (applyError === undefined) {
      const loaded = await loadInNewProcess(fixture.dir, plugins, stateDir, tmp);
      record.load = n.value(loaded);

      const [, destroyError] = await attempt(() => opened.destroy());
      record.destroy = n.outcome(destroyError);
      record.after_destroy = {
        entities: n.entities(await rawEntities(config)),
        state: n.state(stateDir),
      };
    }

    return record;
  } finally {
    await config?.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * What the pretty logger writes for a fresh apply at info, as the Go program's
 * prettyLog records Go's example: the fixture applied again, in a state
 * directory of its own, with processed event data, into a buffer.
 */
async function prettyLog(fixture: Fixture, plugins: string, tmp: string, n: Normaliser): Promise<unknown> {
  const out = collector();
  const config = await newConfig(fixture, plugins, join(tmp, "pretty-state"), tmp, { onEvent: prettylog.handler({ out, level: "info" }), eventData: EventDataLevel.Processed });
  try {
    const [, error] = await attempt(() => config.apply(fixture.main));
    if (error !== undefined) {
      return n.outcome(error);
    }
  } finally {
    await config.close();
  }
  return n.prettyGroups(out.text);
}

/** The text `printEntity` prints, with computed values, for every entity that is not a builtin, by address; a failure is its outcome. */
async function printedEntitiesSection(config: Config, n: Normaliser): Promise<JsonObject> {
  const printed: JsonObject = {};
  for (const raw of await rawEntities(config)) {
    const meta = metaOfRecord(raw);
    if (BUILTIN_TYPES.has(meta.type)) {
      continue;
    }
    const address = String(meta.id ?? "");
    const out = collector();
    const [, error] = await attempt(async () => config.printEntity(await config.find(address), { out, includeComputed: true }));
    printed[address] = error !== undefined ? n.outcome(error) : n.text(out.text);
  }
  return printed;
}

/** The four encode choices, by the name the record gives each, in the order their names are joined in a combination's name. */
const ENCODE_CHOICES: ReadonlyArray<readonly [string, keyof EncodeOptions]> = [
  ["computed", "includeComputed"],
  ["empty", "includeEmpty"],
  ["reveal", "revealSensitive"],
  ["references", "showReferences"],
];

/** xcl's own block types, which the encoder refuses and the encode stage leaves out. */
const BUILTIN_TYPES: ReadonlySet<unknown> = new Set(["variable", "output", "module", "root"]);

/**
 * All sixteen combinations of the encode choices, as the Go program orders and
 * names them. A combination is named by the choices it turns on, joined with
 * `+`, and `none` when it turns on none.
 */
export function encodeCombinations(): Array<readonly [string, EncodeOptions]> {
  const combinations: Array<readonly [string, EncodeOptions]> = [];
  for (let mask = 0; mask < 1 << ENCODE_CHOICES.length; mask++) {
    const names: string[] = [];
    const options: EncodeOptions = {};
    ENCODE_CHOICES.forEach(([name, option], bit) => {
      const on = (mask & (1 << bit)) !== 0;
      options[option] = on;
      if (on) {
        names.push(name);
      }
    });
    combinations.push([names.length > 0 ? names.join("+") : "none", options]);
  }
  return combinations;
}

function metaOfRecord(entity: JsonObject): JsonObject {
  return typeof entity.meta === "object" && entity.meta !== null ? (entity.meta as JsonObject) : {};
}

/** The class a fixture registers for a type and subtype, or undefined when it registers none. */
function registeredClass(fixture: Fixture, type: unknown, subtype: unknown): EntityClass | undefined {
  return (FIXTURES[fixture.name] as readonly EntityClass[]).find((candidate) => {
    const names = entityNameOf(candidate);
    return names !== undefined && names.type === type && names.subtype === (subtype ?? "");
  });
}

/**
 * The configuration text of every entity that is not a builtin, by address,
 * under every combination: `looked_up` encodes the entity a lookup returns,
 * `saved` its record in state, and, for the addresses the fixture's
 * `hand_built.json` lists, `hand_built` the instance `types.ts` builds for it.
 * A failure is recorded as its outcome.
 */
async function encodeSection(config: Config, fixture: Fixture, stateDir: string, n: Normaliser, options: RunOptions): Promise<JsonObject> {
  const saved = savedRecords(stateDir);
  const builders = HAND_BUILT[fixture.name] ?? {};

  const encoded: JsonObject = {};
  for (const raw of await rawEntities(config)) {
    const meta = metaOfRecord(raw);
    if (BUILTIN_TYPES.has(meta.type)) {
      continue;
    }
    const address = String(meta.id ?? "");

    const typedClass = options.typedLookups ? registeredClass(fixture, meta.type, meta.subtype) : undefined;
    const entity = typedClass === undefined ? await config.find(address) : await config.find(typedClass, address);
    const isHandBuilt = fixture.handBuilt.includes(address);

    const lookedUp: JsonObject = {};
    const savedTexts: JsonObject = {};
    const handBuilt: JsonObject = {};
    for (const [name, choices] of encodeCombinations()) {
      lookedUp[name] = n.encoded(...(await attempt(() => config.encodeEntity(entity, choices))));

      const record = saved.get(address);
      savedTexts[name] =
        record === undefined ? { ok: false, error: { code: "missing_saved_record" } } : n.encoded(...(await attempt(() => config.encodeSavedEntity(record, choices))));

      if (isHandBuilt) {
        const build = builders[address];
        if (build === undefined) {
          throw new Error(`fixture ${fixture.name} lists ${address} in hand_built.json, and test/parity/types.ts does not build it`);
        }
        const built = build();
        handBuilt[name] = n.encoded(...(await attempt(() => config.encodeEntity(built, choices))));
      }
    }

    const texts: JsonObject = { looked_up: lookedUp, saved: savedTexts };
    if (isHandBuilt) {
      texts.hand_built = handBuilt;
    }
    encoded[address] = texts;
  }

  return encoded;
}

/** The records of the state directory, by entity id, as JSON text. */
function savedRecords(stateDir: string): Map<string, string> {
  const byId = new Map<string, string>();

  let records: unknown;
  try {
    records = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
  } catch {
    return byId;
  }
  if (!Array.isArray(records)) {
    return byId;
  }

  for (const record of records as unknown[]) {
    if (isObject(record) && isObject(record.meta)) {
      byId.set(String(record.meta.id ?? ""), JSON.stringify(record));
    }
  }
  return byId;
}

/** Runs this program with `--load` and returns the entities it printed. */
async function loadInNewProcess(fixtureDir: string, plugins: string, stateDir: string, tmp: string): Promise<unknown> {
  const script = fileURLToPath(import.meta.url);
  const { stdout } = await runExecutable(process.execPath, [script, "--load", "--fixture", fixtureDir, "--plugins", plugins, "--state", stateDir, "--tmp", tmp], {
    env: { ...process.env, HOME: join(tmp, "home") },
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`load in a new process: the load printed ${JSON.stringify(stdout)}: ${String(error)}`);
  }
}

/** The `--load` mode: load the state and print the entities. */
async function runLoad(fixtureDir: string, plugins: string, stateDir: string, tmp: string): Promise<void> {
  const fixture = readFixture(fixtureDir);
  const config = await newConfig(fixture, plugins, stateDir, tmp);
  try {
    const n = new Normaliser({ tmp, fixture: fixture.dir });
    const [, error] = await attempt(() => config.load());
    const result: JsonObject = { load: n.outcome(error) };
    result.entities = n.entities(await rawEntities(config));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await config.close();
  }
}

/** Renders values with the run's paths replaced, as the Go normaliser does. */
export class Normaliser {
  readonly tmp: string;
  readonly fixture: string;

  constructor(options: { tmp: string; fixture: string }) {
    this.tmp = options.tmp;
    this.fixture = options.fixture;
  }

  /** Whether an operation succeeded, and on failure its error and each problem it collects. */
  outcome(error: XclError | undefined): JsonObject {
    if (error === undefined) {
      return { ok: true };
    }

    const out: JsonObject = { ok: false, error: this.problem(error) };

    const configError = firstInTree(error, (candidate) => candidate.code === "config");
    if (configError !== undefined) {
      const problems = configError.causes.map((cause) => this.problem(cause));
      // the Go program sorts by fmt.Sprint of each problem map
      problems.sort((left, right) => compare(goSprintKey(left), goSprintKey(right)));
      out.problems = problems;
    }

    return out;
  }

  /**
   * One error: its code, and for a diagnostic its file, line, column, summary,
   * detail, block and field. The Go program matches a Diagnostic anywhere in
   * the error's tree first, then a ConfigError. The engine sends a Diagnostic
   * as the error with a `severity` detail beside its `summary`, `detail`,
   * `entity` and `field`, and its `file`, `line` and `column` when it has a
   * position.
   */
  problem(error: XclError): JsonObject {
    const diagnostic = firstInTree(error, (candidate) => "severity" in candidate.details);
    if (diagnostic !== undefined) {
      const details = diagnostic.details;
      const record: JsonObject = {
        code: "config",
        summary: this.text(details.summary ?? ""),
        detail: this.text(details.detail ?? ""),
        entity: details.entity ?? "",
        field: details.field ?? "",
      };
      if ("file" in details) {
        record.file = this.path(details.file as string);
        record.line = integer(details.line);
        record.column = integer(details.column);
      }
      return record;
    }

    if (firstInTree(error, (candidate) => candidate.code === "config") !== undefined) {
      return { code: "config" };
    }

    return { code: "internal", message: this.text(error.message) };
  }

  /** A diff, or the error it failed with. */
  diff(diff: Diff | undefined, error: XclError | undefined): unknown {
    if (error !== undefined) {
      return this.outcome(error);
    }
    return this.value((diff as Diff).raw);
  }

  /** Entities as JSON, sorted by id. */
  entities(entities: readonly unknown[]): unknown[] {
    return sortedById(entities.map((entity) => this.value(entity)));
  }

  /** The records of the state directory, sorted by id; null when there are none. */
  state(stateDir: string): unknown {
    let data: string;
    try {
      data = readFileSync(join(stateDir, "state.json"), "utf8");
    } catch {
      return null;
    }

    let records: unknown;
    try {
      records = JSON.parse(data);
    } catch {
      return { error: "state is not a JSON array" };
    }
    if (records === null) {
      return [];
    }
    if (!Array.isArray(records)) {
      return { error: "state is not a JSON array" };
    }

    return sortedById((records as unknown[]).map((record) => this.walk(record)));
  }

  /** Encoded text with the run's paths replaced, or the outcome of the error it failed with. */
  encoded(text: string | undefined, error: XclError | undefined): unknown {
    if (error !== undefined) {
      return this.outcome(error);
    }
    return this.text(text as string);
  }

  /** The report `formatError` gives for an error, plain and wrapped at 80 columns, or an empty string for none. */
  printedError(error: XclError | undefined): string {
    if (error === undefined) {
      return "";
    }
    return this.text(formatError(error));
  }

  /** The change summary `printDiff` prints for a diff, or the outcome the diff failed with. */
  printedDiff(diff: Diff | undefined, error: XclError | undefined): unknown {
    if (error !== undefined) {
      return this.outcome(error);
    }
    const out = collector();
    printDiff(diff as Diff, { out });
    return this.text(out.text);
  }

  /**
   * The logged events with paths replaced in their messages, sorted as the Go
   * program sorts them: by operation, resource, level and message, so the order
   * the events arrived in does not count.
   */
  log(entries: readonly LogEntry[]): JsonObject[] {
    const rendered = entries.map((entry) => ({ level: entry.level, message: this.text(entry.message), resource: entry.resource, operation: entry.operation }));
    return rendered.sort(
      (left, right) => compare(left.operation, right.operation) || compare(left.resource, right.resource) || compare(left.level, right.level) || compare(left.message, right.message),
    );
  }

  /**
   * Pretty logger output as sorted groups, as the Go program's prettyGroups
   * gives them. A line that does not start with a space starts a group and the
   * lines beneath it join it. Colour codes are removed, each group's leading
   * time is replaced by `<time>` and every duration by `<duration>`, and run
   * paths are replaced; sorting keeps entities created concurrently from
   * reordering the groups.
   */
  prettyGroups(text: string): string[] {
    const groups: string[] = [];
    let current: string[] | undefined;
    for (const raw of text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\n+$/, "").split("\n")) {
      if (raw === "") {
        continue;
      }
      if (!raw.startsWith(" ")) {
        if (current !== undefined) {
          groups.push(this.text(current.join("\n")));
        }
        current = [raw.replace(/^\d{1,2}:\d{2}(AM|PM) /, "<time> ").replace(/duration=\S+/g, "duration=<duration>")];
        continue;
      }
      current?.push(raw);
    }
    if (current !== undefined) {
      groups.push(this.text(current.join("\n")));
    }
    return groups.sort(compare);
  }

  /** Any value through JSON, with the run's paths replaced. */
  value(value: unknown): unknown {
    let decoded: unknown;
    try {
      decoded = JSON.parse(JSON.stringify(value ?? null));
    } catch (error) {
      return { error: String(error) };
    }
    return this.walk(decoded);
  }

  /** Replaces paths in every string of a decoded JSON value. */
  walk(value: unknown): unknown {
    if (typeof value === "string") {
      return this.text(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.walk(item));
    }
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.walk(item)]));
    }
    return value;
  }

  /** Replaces the fixture and temporary directories in a path, written with forward slashes. */
  path(path: string): string {
    return this.text(path.replaceAll(sep, "/"));
  }

  /** Replaces the fixture and temporary directories wherever they appear. */
  text(text: string): string {
    let replaced = text;
    for (const directory of directoryForms(this.fixture)) {
      replaced = replaced.replaceAll(directory, "<fixture>");
    }
    for (const directory of directoryForms(this.tmp)) {
      replaced = replaced.replaceAll(directory, "<tmp>");
    }
    return replaced;
  }
}

/**
 * The ways a directory appears in the record, as the Go program's dirForms
 * lists them: with each backslash doubled, as configuration text writes a
 * Windows path inside a quoted string, as it is, and with forward slashes.
 */
function directoryForms(directory: string): [string, string, string] {
  return [directory.replaceAll("\\", "\\\\"), directory, directory.replaceAll(sep, "/")];
}

/** The first error in the tree, depth first, that `matches`; how Go's errors.As walks it. */
function firstInTree(error: XclError, matches: (candidate: XclError) => boolean): XclError | undefined {
  if (matches(error)) {
    return error;
  }
  for (const cause of error.causes) {
    const found = firstInTree(cause, matches);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function integer(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Orders strings as Go and Python do, not by locale. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The text `fmt.Sprint` gives a Go `map[string]any`: keys sorted, `map[k:v k:v]`. */
export function goSprintKey(problem: JsonObject): string {
  const parts = Object.keys(problem)
    .sort(compare)
    .map((key) => `${key}:${goSprintValue(problem[key])}`);
  return `map[${parts.join(" ")}]`;
}

function goSprintValue(value: unknown): string {
  if (isObject(value)) {
    return goSprintKey(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(goSprintValue).join(" ")}]`;
  }
  return String(value);
}

function sortedById(rendered: unknown[]): unknown[] {
  return rendered.sort((left, right) => compare(entityId(left), entityId(right)));
}

function entityId(value: unknown): string {
  if (!isObject(value) || !isObject(value.meta)) {
    return "";
  }
  return typeof value.meta.id === "string" ? value.meta.id : "";
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      fixture: { type: "string" },
      plugins: { type: "string", default: "" },
      out: { type: "string", default: "" },
      load: { type: "boolean", default: false },
      state: { type: "string", default: "" },
      tmp: { type: "string", default: "" },
      "typed-lookups": { type: "boolean", default: false },
    },
  });

  if (values.fixture === undefined) {
    throw new Error("--fixture is required");
  }

  if (values.load) {
    await runLoad(values.fixture, values.plugins, values.state, values.tmp);
    return;
  }

  const record = await run(values.fixture, values.plugins, { typedLookups: values["typed-lookups"] });
  const encoded = JSON.stringify(record, null, 2);

  if (values.out === "") {
    process.stdout.write(`${encoded}\n`);
    return;
  }
  writeFileSync(values.out, `${encoded}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`parity: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
