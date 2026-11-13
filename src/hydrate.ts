/**
 * The name rule, and entity JSON as values.
 *
 * Properties are camelCase in TypeScript and snake_case in configuration, state
 * and entity JSON, converted by the one pair of functions here. Everything
 * that crosses the boundary calls them and none converts by hand.
 */

import { fieldsOf, type EntityClass, type FieldSpec } from "./decorators.js";
import { NotEncodableError, NotRegisteredError, SchemaError, TypeMismatchError } from "./errors.js";
import type { Registration } from "./schema.js";
import { isSensitive, Sensitive } from "./sensitive.js";

/** A name as configuration writes it: an upper-case letter becomes `_` and its lower-case form. */
export function toSnake(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** A name as TypeScript writes it: `_x` becomes `X`. */
export function toCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** Whether a TypeScript property name survives the name rule in both directions. */
export function roundTrips(name: string): boolean {
  return toCamel(toSnake(name)) === name;
}

/** An output's address with its name in camelCase: only the last segment is a name of the program's. */
export function outputKey(address: string): string {
  const dot = address.lastIndexOf(".");
  return address.slice(0, dot + 1) + toCamel(address.slice(dot + 1));
}

/** A diff path with its attribute names in camelCase; indexes and map keys are left as they are. */
export function diffPath(path: string): string {
  return path.replace(/\["(?:[^"\\]|\\.)*"\]|[^.[\]]+/g, (segment) => (segment.startsWith("[") ? segment : toCamel(segment)));
}

/** What the engine records about every entity: its address and where it was declared. */
export interface Meta {
  /** The entity's name; the block's label. */
  name: string;
  /** The entity's address, such as `module.db.app.web`. */
  id?: string;
  /** The block type. */
  type?: string;
  /** The block subtype, or empty. */
  subtype?: string;
  /** The module the entity is declared in. */
  module?: string;
  /** The file it is declared in. */
  file?: string;
  /** The line it is declared on. */
  line?: number;
  /** The column it is declared at. */
  column?: number;
  /** Whether configuration disabled it. */
  disabled?: boolean;
  /** The addresses it depends on, as configuration wrote them. */
  dependsOn?: string[];
  /** Its status in state. */
  status?: string;
  /** The addresses it links to. */
  links?: string[];
  /** The references its attributes make. */
  references?: Record<string, string>;
  /** Anything else the engine recorded, by the engine's own key. */
  extra?: Record<string, unknown>;
}

const META_KEYS = new Set(["id", "name", "type", "subtype", "module", "file", "line", "column", "status", "links", "references"]);

type JsonObject = Record<string, unknown>;

/** The `Meta` of an entity's JSON: unknown keys are kept in `extra`. */
export function metaOf(record: JsonObject): Meta {
  const raw = (typeof record.meta === "object" && record.meta !== null ? record.meta : {}) as JsonObject;
  const known: JsonObject = {};
  const extra: JsonObject = {};
  for (const [key, value] of Object.entries(raw)) {
    (META_KEYS.has(key) ? known : extra)[key] = value;
  }
  return {
    id: "",
    name: "",
    type: "",
    subtype: "",
    module: "",
    file: "",
    line: 0,
    column: 0,
    status: "",
    links: [],
    references: {},
    ...known,
    disabled: Boolean(record.disabled ?? false),
    dependsOn: (record.depends_on ?? []) as string[],
    extra,
  } as Meta;
}

const BASE_KEYS = new Set(["meta", "disabled", "depends_on"]);

/**
 * An entity of a type no class was registered for, such as a Go plugin's. It is
 * a view over the engine's JSON, which it holds untouched.
 */
export interface Entity {
  /** What the engine recorded about the entity. */
  readonly meta: Meta;
  /** The entity's attributes, by camelCase name. Values are as the engine wrote them. */
  readonly attributes: Readonly<Record<string, unknown>>;
  /** The entity as an instance of its registered class. Throws `NotRegisteredError` for a class this configuration did not register. */
  as<T extends object>(type: EntityClass<T>): T;
}

/** The one implementation of `Entity`. @internal */
export class GenericEntity implements Entity {
  readonly meta: Meta;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly #record: JsonObject;
  readonly #classes: ClassMap;

  constructor(record: JsonObject, classes: ClassMap) {
    this.#record = record;
    this.#classes = classes;
    this.meta = metaOf(record);
    const attributes: JsonObject = {};
    for (const [key, value] of Object.entries(record)) {
      if (!BASE_KEYS.has(key)) {
        attributes[toCamel(key)] = value;
      }
    }
    this.attributes = attributes;
  }

  as<T extends object>(type: EntityClass<T>): T {
    return typedEntity(this.#record, type, this.#classes);
  }

  /** The engine's JSON for this entity, unchanged. */
  toJSON(): JsonObject {
    return this.#record;
  }
}

/** The block types a configuration's registries declare, by class and by type and subtype. */
export class ClassMap {
  readonly #byNames = new Map<string, EntityClass>();
  readonly #byClass = new Map<EntityClass, { type: string; subtype: string }>();

  constructor(registrations: Iterable<Registration> = []) {
    for (const registration of registrations) {
      const names = { type: registration.type, subtype: registration.subtype };
      const existing = this.#byClass.get(registration.ctor);
      if (existing !== undefined && dotted(existing) !== dotted(names)) {
        throw new SchemaError(`${registration.ctor.name} is registered as both ${dotted(existing)} and ${dotted(names)} in one configuration; a class may be one block type per configuration`);
      }
      this.#byClass.set(registration.ctor, names);
      this.#byNames.set(dotted(names), registration.ctor);
    }
  }

  /** The class registered for a type and subtype, or undefined when there is none. */
  classFor(type: string, subtype: string): EntityClass | undefined {
    return this.#byNames.get(dotted({ type, subtype }));
  }

  /** The type and subtype a class is registered as. Throws `NotRegisteredError` when it is not. */
  namesOf(ctor: EntityClass): { type: string; subtype: string } {
    const names = this.#byClass.get(ctor);
    if (names === undefined) {
      const name = ctor?.name || String(ctor);
      throw new NotRegisteredError(`${name} is not registered on this configuration; register it with register(${name}) on one of its registries`, { details: { class: name } });
    }
    return names;
  }
}

function dotted(names: { type: string; subtype: string }): string {
  return names.subtype ? `${names.type}.${names.subtype}` : names.type;
}

/** Entity JSON bytes as an object. */
export function parseRecord(data: Uint8Array): JsonObject {
  return JSON.parse(new TextDecoder().decode(data)) as JsonObject;
}

/** An entity's JSON as the class registered for its type, or a generic `Entity` for a type with none. */
export function hydrate(record: JsonObject, classes: ClassMap): object {
  const meta = metaOf(record);
  const ctor = classes.classFor(meta.type ?? "", meta.subtype ?? "");
  return ctor === undefined ? new GenericEntity(record, classes) : hydrateRoot(ctor, record);
}

/** An entity's JSON as an instance of `ctor`, which must be registered and match the entity's type. */
export function typedEntity<T extends object>(record: JsonObject, ctor: EntityClass<T>, classes: ClassMap): T {
  const want = classes.namesOf(ctor);
  const meta = metaOf(record);
  const got = { type: meta.type ?? "", subtype: meta.subtype ?? "" };
  if (dotted(got) !== dotted(want)) {
    throw new TypeMismatchError(`the entity at ${meta.id ?? "?"} is a ${dotted(got)}, not a ${dotted(want)}`, {
      details: { address: meta.id ?? "", want: dotted(want), got: dotted(got) },
    });
  }
  return hydrateRoot(ctor, record);
}

// the JSON each entity was hydrated from, read back when encoding so a field
// still holding what hydration set is written exactly as the engine wrote it
const sources = new WeakMap<object, JsonObject>();

/** The JSON an instance was hydrated from, or undefined for one built by hand. */
export function sourceOf(instance: object): JsonObject | undefined {
  return sources.get(instance);
}

function hydrateRoot<T extends object>(ctor: EntityClass<T>, record: JsonObject): T {
  const instance = hydrateInto(ctor, record, true);
  sources.set(instance, record);
  return instance;
}

function hydrateInto<T extends object>(ctor: EntityClass<T>, data: JsonObject, top: boolean): T {
  const instance = new ctor();
  const target = instance as Record<string, unknown>;
  const fields = fieldsOf(ctor);
  const labels = top ? labelsOf(fields, data) : new Map<string, string>();

  for (const field of fields) {
    if (top && field.kind === "meta") {
      target[field.property] = metaOf(data);
      continue;
    }
    const label = labels.get(field.property);
    if (label !== undefined) {
      target[field.property] = label;
      continue;
    }
    const key = toSnake(field.property);
    if (key in data) {
      target[field.property] = hydrateValue(field, data[key]);
    }
  }
  return instance;
}

/** The values of an entity's label fields: one holds the name, two the subtype and the name. */
function labelsOf(fields: readonly FieldSpec[], data: JsonObject): Map<string, string> {
  const labelFields = fields.filter((field) => field.kind === "label");
  const meta = metaOf(data);
  if (labelFields.length === 2) {
    return new Map([
      [(labelFields[0] as FieldSpec).property, meta.subtype ?? ""],
      [(labelFields[1] as FieldSpec).property, meta.name],
    ]);
  }
  return new Map(labelFields.map((field) => [field.property, meta.name]));
}

function hydrateValue(field: FieldSpec, value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  switch (field.kind) {
    case "sensitive":
      return sensitiveOf(value);
    case "block":
      return hydrateBlock(field, value);
    case "blocks":
      return Array.isArray(value) ? value.map((element) => hydrateBlock(field, element)) : value;
    case "namedBlocks":
      return isObject(value) ? Object.fromEntries(Object.entries(value).map(([name, element]) => [name, hydrateBlock(field, element)])) : value;
    default:
      return value;
  }
}

function hydrateBlock(field: FieldSpec, value: unknown): unknown {
  return isObject(value) ? hydrateInto((field.block as () => EntityClass)(), value, false) : value;
}

function sensitiveOf(value: unknown): Sensitive<unknown> {
  return isMasked(value) ? Sensitive.redacted() : new Sensitive(value);
}

/** Whether a JSON value is the engine's sensitive marker or a masked envelope. */
export function isMasked(value: unknown): boolean {
  return value === "(sensitive)" || (isObject(value) && "xcl_masked" in value);
}

/**
 * An entity's JSON as the engine reads it, the mirror of hydration: from an
 * instance of a registered class, looked up or built by hand, or from a
 * generic entity, whose JSON it already holds.
 *
 * An entity hydrated from the engine's JSON is written from that JSON wherever
 * a field still holds what hydration set, so the engine reads back exactly what
 * it wrote, and from the instance wherever a field was changed since.
 */
export function recordOf(entity: unknown, classes: ClassMap): JsonObject {
  if (entity instanceof GenericEntity) {
    return entity.toJSON();
  }
  if (!isClassInstance(entity)) {
    throw notEncodable(`a value of type ${describe(entity)}`, "it is not an entity");
  }

  const ctor = entity.constructor as EntityClass;
  const { type, subtype } = classes.namesOf(ctor);
  const source = sourceOf(entity);
  const fields = fieldsOf(ctor);
  const target = entity as JsonObject;

  const metaField = fields.find((field) => field.kind === "meta");
  const held = metaField === undefined ? undefined : target[metaField.property];
  const meta: JsonObject = isObject(held) ? metaRecord(held as unknown as Meta) : isObject(source?.meta) ? { ...source.meta } : {};
  meta.type = type;
  delete meta.subtype;
  if (subtype) {
    meta.subtype = subtype;
  }

  // one label field holds the name, two the subtype and the name
  const labels = fields.filter((field) => field.kind === "label");
  const name = labels.length > 0 ? target[(labels[labels.length - 1] as FieldSpec).property] : meta.name;
  delete meta.name;
  if (name) {
    meta.name = name;
  } else if (labels.length > 0 || metaField !== undefined) {
    throw notEncodable(`a ${dotted({ type, subtype })} entity`, "it has no name; set its label field or meta.name");
  }

  const record: JsonObject = { meta };
  if (isObject(held)) {
    const declared = held as unknown as Meta;
    if (declared.disabled) {
      record.disabled = true;
    }
    if (declared.dependsOn && declared.dependsOn.length > 0) {
      record.depends_on = [...declared.dependsOn];
    }
  } else if (source !== undefined) {
    if (source.disabled) {
      record.disabled = true;
    }
    if (Array.isArray(source.depends_on) && source.depends_on.length > 0) {
      record.depends_on = [...source.depends_on];
    }
  }
  return Object.assign(record, recordInto(entity, source, true));
}

/** The entity's JSON from `recordOf`, serialised for the engine. */
export function recordBytes(entity: unknown, classes: ClassMap): Uint8Array {
  const record = recordOf(entity, classes);
  try {
    assertEncodable(record);
    return new TextEncoder().encode(JSON.stringify(record));
  } catch (cause) {
    throw notEncodable(`a value of type ${describe(entity)}`, "it holds a value with no configuration form", cause);
  }
}

const META_RECORD_KEYS = ["id", "name", "type", "subtype", "module", "file", "line", "column", "status", "links", "references"] as const;

function metaRecord(meta: Meta): JsonObject {
  const record: JsonObject = {};
  for (const key of META_RECORD_KEYS) {
    const value = meta[key];
    if (Array.isArray(value) ? value.length > 0 : isObject(value) ? Object.keys(value).length > 0 : Boolean(value)) {
      record[key] = value;
    }
  }
  return Object.assign(record, meta.extra);
}

function recordInto(instance: object, source: JsonObject | undefined, top: boolean): JsonObject {
  const ctor = instance.constructor as EntityClass;
  const target = instance as JsonObject;
  const data: JsonObject = {};
  let defaults: JsonObject | undefined;
  for (const field of fieldsOf(ctor)) {
    if (top && (field.kind === "meta" || field.kind === "label")) {
      continue;
    }
    const key = toSnake(field.property);
    const value = target[field.property];
    if (source !== undefined) {
      if (key in source && equal(hydrateValue(field, source[key]), value)) {
        data[key] = source[key];
        continue;
      }
      if (!(key in source)) {
        defaults ??= new ctor() as JsonObject;
        if (equal(value, defaults[field.property])) {
          continue;
        }
      }
    }
    if (value === undefined || value === null) {
      continue;
    }
    data[key] = recordValue(field, value, source?.[key]);
  }
  return data;
}

function recordValue(field: FieldSpec, value: unknown, source: unknown): unknown {
  if (isSensitive(value)) {
    return value.isRedacted ? "(sensitive)" : value.reveal();
  }
  if (field.kind === "block") {
    return isClassInstance(value) ? recordInto(value, isObject(source) ? source : undefined, false) : value;
  }
  if (field.kind === "blocks" && Array.isArray(value)) {
    const elements = Array.isArray(source) ? source : [];
    return value.map((element: unknown, index) => recordValue({ ...field, kind: "block" }, element, elements[index]));
  }
  if (field.kind === "namedBlocks" && isObject(value)) {
    const entries = isObject(source) ? source : {};
    return Object.fromEntries(Object.entries(value).map(([name, element]) => [name, recordValue({ ...field, kind: "block" }, element, entries[name])]));
  }
  return value;
}

function equal(left: unknown, right: unknown): boolean {
  if (isSensitive(left) || isSensitive(right)) {
    return isSensitive(left) && isSensitive(right) && left.isRedacted === right.isRedacted && equal(left.reveal(), right.reveal());
  }
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length && left.every((element, index) => equal(element, right[index]));
  }
  if (typeof left === "object" && left !== null) {
    if (typeof right !== "object" || right === null || Array.isArray(right) || Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) {
      return false;
    }
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => equal((left as JsonObject)[key], (right as JsonObject)[key]));
  }
  return Object.is(left, right);
}

function assertEncodable(value: unknown): void {
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`a ${typeof value} has no configuration form`);
  }
  if (Array.isArray(value)) {
    value.forEach(assertEncodable);
  } else if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(assertEncodable);
  }
}

function isClassInstance(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto !== null && proto !== Object.prototype;
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return typeof value === "object" ? ((value as object).constructor?.name ?? "object") : typeof value;
}

function notEncodable(what: string, reason: string, cause?: unknown): NotEncodableError {
  // worded as the engine words its own not-encodable error
  return new NotEncodableError(`${what} cannot be encoded as configuration: ${reason}`, { details: { what, reason }, cause });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
