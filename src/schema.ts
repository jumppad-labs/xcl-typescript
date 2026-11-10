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

import { Any, entityNameOf, fieldsOf, Int, type EntityClass, type FieldSpec, type FunctionSpec, type TypeSpec } from "./decorators.js";
import { SchemaError } from "./errors.js";
import { roundTrips, toSnake } from "./hydrate.js";
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

function isList(spec: TypeSpec | undefined): spec is readonly [TypeSpec] {
  return Array.isArray(spec) && spec.length === 1;
}

function isMap(spec: TypeSpec | undefined): spec is { readonly map: TypeSpec } {
  return typeof spec === "object" && spec !== null && !Array.isArray(spec) && "map" in spec;
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

function fieldDocuments(ctor: EntityClass, probe: object, top: boolean, visiting: Set<EntityClass>): FieldDocument[] {
  const documents: FieldDocument[] = [];
  for (const field of fieldsOf(ctor)) {
    const where = `${nameOf(ctor)}.${field.property}`;
    if (!roundTrips(field.property) || toSnake(field.property).startsWith("_")) {
      throw new SchemaError(`field ${where}: the name does not survive conversion to configuration and back; use a camelCase name`);
    }
    if (field.kind === "meta") {
      if (!top) {
        throw new SchemaError(`field ${where}: a nested block has no metadata; @Meta belongs on an entity class`);
      }
      continue;
    }
    if (field.kind === "label") {
      continue;
    }
    const name = toSnake(field.property);
    if (top && RESERVED.has(name)) {
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
      return attributeDocument(document, field, where, initial);
    case "sensitive":
      return sensitiveDocument(document, field, where, initial);
    case "computed":
      return computedDocument(document, field, where, initial);
    default:
      return blockDocument(document, field, where, initial, visiting);
  }
}

function attributeDocument(document: FieldDocument, field: FieldSpec, where: string, initial: unknown): FieldDocument {
  const shape = shapeOf(field.type, where);
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
  assertAgrees(field.type as TypeSpec, initial, where);
  document.optional = true;
  if (!isEmptyCollection(initial)) {
    document.default = jsonValue(initial, where);
  }
  return document;
}

function sensitiveDocument(document: FieldDocument, field: FieldSpec, where: string, initial: unknown): FieldDocument {
  const shape = shapeOf(field.type, where);
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

function computedDocument(document: FieldDocument, field: FieldSpec, where: string, initial: unknown): FieldDocument {
  const shape = shapeOf(field.type, where);
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

function blockDocument(document: FieldDocument, field: FieldSpec, where: string, initial: unknown, visiting: Set<EntityClass>): FieldDocument {
  let element: EntityClass;
  try {
    element = (field.block as () => EntityClass)();
  } catch (cause) {
    throw new SchemaError(`field ${where}: its block must be given as a function returning a class, such as () => Health`, { cause });
  }
  if (typeof element !== "function") {
    throw new SchemaError(`field ${where}: its block must be given as a function returning a class, such as () => Health`);
  }
  if (visiting.has(element)) {
    throw new SchemaError(`field ${where}: ${nameOf(element)} contains itself, which configuration cannot write`);
  }
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
    params: spec.params.map((param, index) => ({ name: `arg${index}`, type: functionType(param, where) })),
    return: functionType(spec.result, where),
  };
}

function functionType(spec: TypeSpec, where: string): unknown {
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
    return ["list", functionType(spec[0], where)];
  }
  if (isMap(spec)) {
    return ["map", functionType(spec.map, where)];
  }
  throw new SchemaError(`${where}: this type cannot cross to configuration; use String, Boolean, Number, Int, [T] or { map: T }`);
}

interface Shape {
  type: unknown;
  format?: string;
}

function shapeOf(spec: TypeSpec | undefined, where: string): Shape {
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
    const element = shapeOf(spec[0], where);
    return element.format ? { type: { list: element.type }, format: element.format } : { type: { list: element.type } };
  }
  if (isMap(spec)) {
    const element = shapeOf(spec.map, where);
    return element.format ? { type: { map: element.type }, format: element.format } : { type: { map: element.type } };
  }
  throw new SchemaError(`field ${where}: this type has no configuration form; use String, Number, Boolean, Int, Any, [T] or { map: T }`);
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
