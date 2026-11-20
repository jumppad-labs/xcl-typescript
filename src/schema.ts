/**
 * Schema v1 from decorated classes: the language-neutral description of a
 * block type the engine builds its Go type from.
 *
 * Registering a class constructs it once. That one instance supplies the field
 * table under standard decorators, the defaults under both forms, and the
 * check that an initializer agrees with its decorator, so everything that can
 * be wrong with a class is reported from registration, naming the class and
 * field.
 */

import {
  Any,
  entityNameOf,
  fieldsOf,
  Int,
  isClassThunk,
  isEntityClass,
  isListSpec as isList,
  isMapSpec as isMap,
  type ClassThunk,
  type EntityClass,
  type FieldSpec,
  type FunctionSpec,
  type TypeSpec,
} from "./decorators.js";
import { SchemaError } from "./errors.js";
import { recordTyped, roundTrips, toSnake } from "./hydrate.js";
import { isSensitive } from "./sensitive.js";

/** A schema v1 document, in the form the engine's reader expects. */
export type SchemaV1 = Record<string, unknown>;

/** A class bound to its block type, with its schema derived. */
export interface Registration {
  type: string;
  subtype: string;
  ctor: EntityClass;
  schema: SchemaV1;
}

type FieldDocument = Record<string, unknown>;

const RESERVED = new Set(["meta", "disabled", "depends_on"]);

function nameOf(ctor: EntityClass): string {
  return ctor.name || "the class";
}

/** Constructs a class with no arguments, as hydration will, refusing one that cannot be. */
export function probeOf(ctor: EntityClass): object {
  if (typeof ctor !== "function") {
    throw new SchemaError(`${String(ctor)} is not a class, so it cannot describe an entity type`);
  }
  if (ctor.length > 0) {
    throw new SchemaError(`${nameOf(ctor)} cannot be constructed with no arguments; an entity class takes no constructor arguments`);
  }
  try {
    return new ctor();
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new SchemaError(`${nameOf(ctor)} cannot be constructed with no arguments: ${reason}`, { cause });
  }
}

/** The registration of a class named by `@Entity`, its schema derived. */
export function registrationOf(ctor: EntityClass): Registration {
  const probe = probeOf(ctor);
  const names = entityNameOf(ctor);
  if (names === undefined) {
    throw new SchemaError(`${nameOf(ctor)} has no entity type; decorate the class itself with @Entity("type")`);
  }
  if (!names.type) {
    throw new SchemaError(`${nameOf(ctor)} must name its entity type, such as @Entity("app")`);
  }
  return { type: names.type, subtype: names.subtype, ctor, schema: schemaFor(ctor, probe, names.type, names.subtype) };
}

function schemaFor(ctor: EntityClass, probe: object, type: string, subtype: string): SchemaV1 {
  const fields = fieldsOf(ctor);
  const labels = fields.filter((field) => field.kind === "label");
  const hasMeta = fields.some((field) => field.kind === "meta");

  const document: SchemaV1 = { schema_version: 1, type };
  if (subtype) {
    document.subtype = subtype;
  }

  if (labels.length === 0 && !hasMeta) {
    if (subtype) {
      throw new SchemaError(`${nameOf(ctor)} has no label field and no metadata field, so its block is written without labels, and its type takes no subtype`);
    }
    document.singleton = true;
  } else if (labels.length > 0 && labels.length !== (subtype ? 2 : 1)) {
    throw new SchemaError(`${nameOf(ctor)} has ${labels.length} label fields, a block of its type has ${subtype ? 2 : 1} labels`);
  }

  document.fields = fieldDocuments(ctor, probe, true, new Set([ctor]));
  return document;
}

// asEntity is true for a block type's own fields and for an entity value's:
// labels and metadata are left out, being the block's identity, and the names
// every block holds are refused. A nested block's or object value's fields
// take neither rule.
function fieldDocuments(ctor: EntityClass, probe: object, asEntity: boolean, visiting: Set<EntityClass>): FieldDocument[] {
  const documents: FieldDocument[] = [];
  for (const field of fieldsOf(ctor)) {
    const where = `${nameOf(ctor)}.${field.property}`;
    if (!roundTrips(field.property) || toSnake(field.property).startsWith("_")) {
      throw new SchemaError(`field ${where}: the name does not survive conversion to configuration and back; use a camelCase name`);
    }
    if (field.kind === "meta") {
      if (!asEntity) {
        throw new SchemaError(`field ${where}: a nested block has no metadata; @Meta belongs on an entity class`);
      }
      continue;
    }
    if (field.kind === "label") {
      continue;
    }
    const name = toSnake(field.property);
    if (asEntity && RESERVED.has(name)) {
      throw new SchemaError(`field ${where}: "${name}" is held by every block and cannot be declared; read it from the @Meta field`);
    }
    documents.push(fieldDocument(field, name, where, (probe as Record<string, unknown>)[field.property], visiting));
  }
  return documents;
}

function fieldDocument(field: FieldSpec, name: string, where: string, initial: unknown, visiting: Set<EntityClass>): FieldDocument {
  const document: FieldDocument = { name };
  switch (field.kind) {
    case "attribute":
      return attributeDocument(document, field, where, initial, visiting);
    case "sensitive":
      return sensitiveDocument(document, field, where, initial, visiting);
    case "computed":
      return computedDocument(document, field, where, initial, visiting);
    default:
      return blockDocument(document, field, where, initial, visiting);
  }
}

function attributeDocument(document: FieldDocument, field: FieldSpec, where: string, initial: unknown, visiting: Set<EntityClass>): FieldDocument {
  const shape = shapeOf(field.type, where, visiting);
  document.type = shape.type;
  if (shape.format) {
    document.format = shape.format;
  }
  if (initial === undefined || initial === null) {
    if (field.optional) {
      document.optional = true;
      document.nullable = true;
    }
    return document;
  }
  if (shape.entity && !(isEmptyCollection(initial) && (Array.isArray(initial) || Object.getPrototypeOf(initial) === Object.prototype))) {
    throw new SchemaError(`field ${where}: a reference has no default; leave it uninitialised or mark it { optional: true }`);
  }
  assertAgrees(field.type as TypeSpec, initial, where);
  document.optional = true;
  // an instance of an object value's class is a default even with no fields set
  if (isClassThunk(field.type) || !isEmptyCollection(initial)) {
    document.default = jsonValue(recordTyped(field.type as TypeSpec, initial), where);
  }
  return document;
}

function sensitiveDocument(document: FieldDocument, field: FieldSpec, where: string, initial: unknown, visiting: Set<EntityClass>): FieldDocument {
  const shape = shapeOf(field.type, where, visiting);
  if (!canBeSensitive(field.type as TypeSpec)) {
    throw new SchemaError(`field ${where}: a sensitive value of this type cannot be held by the engine; sensitive values may be String, Number, Int, Boolean, [String] or { map: String }`);
  }
  document.type = shape.type;
  if (shape.format) {
    document.format = shape.format;
  }
  if (field.optional) {
    document.optional = true;
  }
  document.sensitive = true;
  if (initial === undefined || initial === null) {
    return document;
  }
  if (!isSensitive(initial)) {
    throw new SchemaError(`field ${where}: a sensitive field's initializer must be a Sensitive value`);
  }
  const value = initial.reveal();
  if (value !== undefined) {
    assertAgrees(field.type as TypeSpec, value, where);
    document.optional = true;
    if (!isEmptyCollection(value)) {
      document.default = jsonValue(value, where);
    }
  }
  return document;
}

function computedDocument(document: FieldDocument, field: FieldSpec, where: string, initial: unknown, visiting: Set<EntityClass>): FieldDocument {
  const shape = shapeOf(field.type, where, visiting);
  if (initial !== undefined && initial !== null) {
    assertAgrees(field.type as TypeSpec, initial, where);
  }
  document.type = shape.type;
  if (shape.format) {
    document.format = shape.format;
  }
  document.computed = true;
  document.nullable = true;
  return document;
}

const BLOCK_THUNK = "its block must be given as a function returning a class, such as () => Health";
const TYPE_THUNK = "its type must be given as a function returning a class, such as () => Endpoint";
const NO_FORM = "this type has no configuration form; use String, Number, Boolean, Int, Any, [T] or { map: T }";

/**
 * The class a block's or an object value's thunk returns, refusing a thunk that
 * returns no class, and a class that would contain itself, since configuration
 * writes a block or a value out whole. A thunk that throws is refused with
 * `refusal`, and one that returns something other than a class with
 * `notAClass`.
 */
function classOf(thunk: ClassThunk, where: string, visiting: Set<EntityClass>, refusal: string, notAClass = refusal): EntityClass {
  let element: EntityClass;
  try {
    element = thunk();
  } catch (cause) {
    throw new SchemaError(`field ${where}: ${refusal}`, { cause });
  }
  if (typeof element !== "function") {
    throw new SchemaError(`field ${where}: ${notAClass}`);
  }
  if (visiting.has(element)) {
    throw new SchemaError(`field ${where}: ${nameOf(element)} contains itself, which configuration cannot write`);
  }
  return element;
}

function blockDocument(document: FieldDocument, field: FieldSpec, where: string, initial: unknown, visiting: Set<EntityClass>): FieldDocument {
  const element = classOf(field.block as ClassThunk, where, visiting, BLOCK_THUNK);
  assertBlockInitial(field, element, initial, where);

  const nested = new Set(visiting).add(element);
  const fields = fieldDocuments(element, probeOf(element), false, nested);
  document.kind = "block";
  document.type = field.kind === "namedBlocks" ? { map: { object: fields } } : { object: fields };
  if (field.kind === "blocks") {
    document.repeated = true;
  }
  const labels = fieldsOf(element).filter((candidate) => candidate.kind === "label");
  if (labels.length > 1) {
    throw new SchemaError(`field ${where}: ${nameOf(element)} has ${labels.length} label fields, a nested block has one label`);
  }
  if (labels[0] !== undefined) {
    document.label = toSnake(labels[0].property);
  }
  if (field.kind === "block" && (field.optional || (initial !== undefined && initial !== null))) {
    document.optional = true;
  }
  return document;
}

function assertBlockInitial(field: FieldSpec, element: EntityClass, initial: unknown, where: string): void {
  if (initial === undefined || initial === null) {
    return;
  }
  const isElement = (value: unknown): boolean => value instanceof element;
  const agrees =
    field.kind === "block"
      ? isElement(initial)
      : field.kind === "blocks"
        ? Array.isArray(initial) && initial.every(isElement)
        : typeof initial === "object" && !Array.isArray(initial) && Object.values(initial).every(isElement);
  if (!agrees) {
    throw new SchemaError(`field ${where}: its initializer disagrees with its decorator`);
  }
}

/** The `plugins.FunctionSignature` document of a function offered to configuration. */
export function signatureOf(spec: FunctionSpec, where: string): Record<string, unknown> {
  return {
    params: spec.params.map((param, index) => ({ name: `arg${index}`, type: functionType(param, where, `parameter arg${index}`) })),
    return: functionType(spec.result, where, "result"),
  };
}

function functionType(spec: TypeSpec, where: string, slot: string): unknown {
  if (spec === String) {
    return "string";
  }
  if (spec === Boolean) {
    return "bool";
  }
  if (spec === Number || spec === Int) {
    return "number";
  }
  if (isList(spec)) {
    return ["list", functionType(spec[0], where, slot)];
  }
  if (isMap(spec)) {
    return ["map", functionType(spec.map, where, slot)];
  }
  if (isClassThunk(spec)) {
    // functions take only scalar, list and map types, so an object value has no form there
    throw new SchemaError(`${where}, ${slot}: the class ${thunkName(spec)} cannot cross to configuration; use String, Boolean, Number, Int, [T] or { map: T }`);
  }
  throw new SchemaError(`${where}: this type cannot cross to configuration; use String, Boolean, Number, Int, [T] or { map: T }`);
}

/** The name of the class a thunk returns, for a refusal, or of the thunk itself when it returns none. */
function thunkName(thunk: ClassThunk): string {
  try {
    const element: unknown = thunk();
    if (typeof element === "function" && element.name) {
      return element.name;
    }
  } catch {
    // named by the thunk below
  }
  return thunk.name || "the class";
}

interface Shape {
  type: unknown;
  format?: string;
  /** The type is, or holds as a list's or map's element, an entity value. */
  entity?: boolean;
}

function shapeOf(spec: TypeSpec | undefined, where: string, visiting: Set<EntityClass>): Shape {
  if (spec === String) {
    return { type: "string" };
  }
  if (spec === Boolean) {
    return { type: "bool" };
  }
  if (spec === Number) {
    return { type: "number", format: "float" };
  }
  if (spec === Int) {
    return { type: "number", format: "int" };
  }
  if (spec === Any) {
    return { type: "any" };
  }
  if (isList(spec)) {
    const element = shapeOf(spec[0], where, visiting);
    return { ...element, type: { list: element.type } };
  }
  if (isMap(spec)) {
    const element = shapeOf(spec.map, where, visiting);
    return { ...element, type: { map: element.type } };
  }
  if (isClassThunk(spec)) {
    return objectShape(spec, where, visiting);
  }
  throw new SchemaError(`field ${where}: ${NO_FORM}`);
}

/**
 * The shape of a class-valued type. A class declaring a label or metadata
 * field is an entity value, as a reference to a block gives it, its fields
 * described as a block type's are; any other class is an object value, its
 * fields described as a nested block's are. A constructor given in place of a
 * thunk, such as `Date`, that returns no class when called has no
 * configuration form.
 */
function objectShape(thunk: ClassThunk, where: string, visiting: Set<EntityClass>): Shape {
  const element = classOf(thunk, where, visiting, TYPE_THUNK, Object.hasOwn(thunk, "prototype") ? NO_FORM : TYPE_THUNK);
  const nested = new Set(visiting).add(element);
  // constructed first, so a standard decorator has recorded the class's fields
  const probe = probeOf(element);
  if (isEntityClass(element)) {
    return { type: { entity: fieldDocuments(element, probe, true, nested) }, entity: true };
  }
  return { type: { object: fieldDocuments(element, probe, false, nested) } };
}

function canBeSensitive(spec: TypeSpec): boolean {
  if (spec === String || spec === Number || spec === Int || spec === Boolean) {
    return true;
  }
  if (isList(spec)) {
    return spec[0] === String;
  }
  return isMap(spec) && spec.map === String;
}

function assertAgrees(spec: TypeSpec, value: unknown, where: string): void {
  if (!agrees(spec, value)) {
    // the value is left out: it may be a secret, and may not be printable
    throw new SchemaError(`field ${where}: its initializer disagrees with its decorator`);
  }
}

function agrees(spec: TypeSpec, value: unknown): boolean {
  if (spec === Any) {
    return true;
  }
  if (spec === String) {
    return typeof value === "string";
  }
  if (spec === Boolean) {
    return typeof value === "boolean";
  }
  if (spec === Number) {
    return Number.isFinite(value);
  }
  if (spec === Int) {
    return Number.isInteger(value);
  }
  if (isList(spec)) {
    return Array.isArray(value) && value.every((element) => agrees(spec[0], element));
  }
  if (isMap(spec)) {
    return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((element) => agrees(spec.map, element));
  }
  if (isClassThunk(spec)) {
    // the thunk was resolved when the field's shape was described
    return value instanceof spec();
  }
  return false;
}

function isEmptyCollection(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return typeof value === "object" && value !== null && Object.keys(value).length === 0;
}

function jsonValue(value: unknown, where: string): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (cause) {
    throw new SchemaError(`field ${where}: its default cannot be written as configuration`, { cause });
  }
}
