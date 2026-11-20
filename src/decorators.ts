/**
 * The decorators that describe an entity type, each accepting the standard and
 * the legacy calling form, and the per-class field table they fill.
 *
 * A standard field decorator receives only a name, Node 22 has no
 * `Symbol.metadata`, and block classes carry no class decorator to collect
 * from. So the legacy form records against `target.constructor`, and the
 * standard form registers `context.addInitializer`, which records against
 * `this.constructor` when an instance is built. Registration always constructs
 * the class once, so both forms have filled the same table by then.
 */

/** Marks an attribute as an integer. */
export const Int: unique symbol = Symbol("xcl.Int");

/** Marks an attribute as holding a value of any type. */
export const Any: unique symbol = Symbol("xcl.Any");

/** A field's type: `String`, `Number`, `Boolean`, `Int`, `Any`, `[T]` for a list or `{ map: T }` for a map. */
export type TypeSpec = StringConstructor | NumberConstructor | BooleanConstructor | typeof Int | typeof Any | readonly [TypeSpec] | { readonly map: TypeSpec };

/** What a field is in configuration. */
export type FieldKind = "attribute" | "sensitive" | "computed" | "block" | "blocks" | "namedBlocks" | "label" | "meta";

/** A class constructible with no arguments. */
export type EntityClass<T extends object = object> = new () => T;

/** What a decorator records about a field. */
export interface FieldSpec {
  property: string;
  kind: FieldKind;
  type?: TypeSpec;
  block?: () => EntityClass;
  optional?: boolean;
}

/** The options of an attribute or block field. */
export interface FieldOptions {
  /** The field can be left out of configuration. */
  optional?: boolean;
}

/** A decorator usable on a field under standard or legacy decorators. */
export interface FieldDecorator {
  /**
   * The standard decorators form: records the field when an instance of its
   * class is built.
   *
   * @param target Always `undefined`, since a field has no value to decorate.
   * @param context The field's decorator context, which names the field.
   */
  <This, Value>(target: undefined, context: ClassFieldDecoratorContext<This, Value>): void;
  /**
   * The `experimentalDecorators` form: records the field against the class at once.
   *
   * @param target The prototype of the class declaring the field.
   * @param property The field's name.
   */
  (target: object, property: string | symbol): void;
}

/** A decorator usable on a class under standard or legacy decorators. */
export interface ClassDecorator {
  /**
   * The standard decorators form.
   *
   * @param target The class decorated.
   * @param context The class's decorator context.
   */
  <C extends abstract new (...args: never[]) => object>(target: C, context: ClassDecoratorContext<C>): void;
  /**
   * The `experimentalDecorators` form.
   *
   * @param target The class decorated.
   */
  <C extends abstract new (...args: never[]) => object>(target: C): void;
}

const fieldTables = new WeakMap<object, Map<string, FieldSpec>>();
const entityNames = new WeakMap<object, { type: string; subtype: string }>();

function isStandardContext(second: unknown): second is ClassFieldDecoratorContext {
  return typeof second === "object" && second !== null && "kind" in second;
}

function record(owner: object, spec: FieldSpec): void {
  let table = fieldTables.get(owner);
  if (table === undefined) {
    table = new Map();
    fieldTables.set(owner, table);
  }
  table.set(spec.property, spec);
}

/** Builds the decorator for one field description, in either calling form. @internal */
export function fieldDecorator(description: Omit<FieldSpec, "property">): FieldDecorator {
  const decorate = (target: unknown, second: unknown): void => {
    if (isStandardContext(second)) {
      const property = String(second.name);
      second.addInitializer(function (this: unknown) {
        record((this as object).constructor, { ...description, property });
      });
      return;
    }
    record((target as object).constructor, { ...description, property: String(second) });
  };
  return decorate as FieldDecorator;
}

/**
 * Every field recorded for a class, a base class's first. A class's own
 * declaration of a field replaces the one it inherits, in the base's position.
 */
export function fieldsOf(ctor: object): FieldSpec[] {
  const chain: object[] = [];
  for (let current: object | null = ctor; current !== null && current !== Function.prototype; current = Object.getPrototypeOf(current)) {
    chain.unshift(current);
  }
  const merged = new Map<string, FieldSpec>();
  for (const owner of chain) {
    for (const [property, spec] of fieldTables.get(owner) ?? []) {
      merged.set(property, spec);
    }
  }
  return [...merged.values()];
}

/** The type and subtype `@Entity` gave a class, or undefined when it has none. */
export function entityNameOf(ctor: object): { type: string; subtype: string } | undefined {
  return entityNames.get(ctor);
}

/** Names a class's block type and optional subtype, which become the block's labels and address. */
export function entityDecorator(type: string, subtype = ""): ClassDecorator {
  const decorate = (target: object): void => {
    entityNames.set(target, { type, subtype });
  };
  return decorate as ClassDecorator;
}

/**
 * Declares an attribute.
 *
 * @param type The attribute's type.
 * @param options Whether the attribute can be left out of configuration.
 * @returns A decorator recording the field as an attribute of `type`.
 */
export function Attribute(type: TypeSpec, options: FieldOptions = {}): FieldDecorator {
  return fieldDecorator({ kind: "attribute", type, optional: options.optional ?? false });
}

/**
 * Declares a field set by a provider, never in configuration.
 *
 * @param type The field's type.
 * @returns A decorator recording the field as a computed value of `type`.
 */
export function Computed(type: TypeSpec): FieldDecorator {
  return fieldDecorator({ kind: "computed", type });
}

/**
 * Declares a nested block.
 *
 * @param block A function returning the block's class, so a class can be named before it is defined.
 * @param options Whether the block can be left out of configuration.
 * @returns A decorator recording the field as one nested block of that class.
 */
export function Block(block: () => EntityClass, options: FieldOptions = {}): FieldDecorator {
  return fieldDecorator({ kind: "block", block, optional: options.optional ?? false });
}

/**
 * Declares a list of blocks, in order.
 *
 * @param block A function returning the blocks' class, so a class can be named before it is defined.
 * @returns A decorator recording the field as a list of blocks of that class.
 */
export function Blocks(block: () => EntityClass): FieldDecorator {
  return fieldDecorator({ kind: "blocks", block });
}

/**
 * Declares named blocks, a record keyed by their label.
 *
 * @param block A function returning the blocks' class, so a class can be named before it is defined.
 * @returns A decorator recording the field as a record of blocks of that class, keyed by label.
 */
export function NamedBlocks(block: () => EntityClass): FieldDecorator {
  return fieldDecorator({ kind: "namedBlocks", block });
}

/**
 * Declares the field that receives the block's label. A type with a subtype takes two.
 *
 * @returns A decorator recording the field as a label field.
 */
export function Label(): FieldDecorator {
  return fieldDecorator({ kind: "label" });
}

/** What `@Func` records about a method. */
export interface FunctionSpec {
  name: string;
  params: readonly TypeSpec[];
  result: TypeSpec;
}

/** The options of `@Func`. */
export interface FuncOptions {
  /** The function's name in configuration, by default the method's name. */
  name?: string;
}

/** A decorator usable on a method under standard or legacy decorators. */
export interface MethodDecorator {
  /**
   * The standard decorators form.
   *
   * @param target The method decorated.
   * @param context The method's decorator context, which names the method.
   */
  <This, Args extends never[], Return>(target: (this: This, ...args: Args) => Return, context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>): void;
  /**
   * The `experimentalDecorators` form.
   *
   * @param target The prototype of the class declaring the method.
   * @param property The method's name.
   * @param descriptor The method's property descriptor, whose `value` is the method.
   */
  (target: object, property: string | symbol, descriptor: PropertyDescriptor): void;
}

const functionSpecs = new WeakMap<object, FunctionSpec>();

/** What `@Func` recorded about a method, or undefined when it has no `@Func`. */
export function functionSpecOf(method: unknown): FunctionSpec | undefined {
  return typeof method === "function" ? functionSpecs.get(method) : undefined;
}

/**
 * Offers a method to configuration, giving its parameter and result types. The
 * method may be synchronous or return a Promise.
 *
 * The decorator itself never throws. A parameter or result type that cannot
 * cross to configuration, such as `Any`, makes `registerFunctions` throw
 * {@link SchemaError}.
 *
 * @param params The types of the method's parameters, in order.
 * @param result The type of the method's result, or of the value its Promise resolves to.
 * @param options The function's name in configuration, by default the method's name.
 * @returns A decorator recording the method's name and types, for `registerFunctions` to offer.
 */
export function Func(params: readonly TypeSpec[], result: TypeSpec, options: FuncOptions = {}): MethodDecorator {
  const decorate = (target: unknown, second: unknown, descriptor?: PropertyDescriptor): void => {
    const standard = typeof second === "object" && second !== null && "kind" in second;
    const method = standard ? target : descriptor?.value;
    const name = options.name ?? String(standard ? (second as ClassMethodDecoratorContext).name : second);
    functionSpecs.set(method as object, { name, params, result });
  };
  return decorate as MethodDecorator;
}

/** Declares the field that receives the block's metadata. @internal */
export function metaDecorator(): FieldDecorator {
  return fieldDecorator({ kind: "meta" });
}
