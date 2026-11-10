/**
 * `Sensitive`: the wrapper type of a secret value, and the decorator of a
 * sensitive field. `new Sensitive("s3cret")` builds a value and
 * `@Sensitive(String)` declares a field; `new.target` tells them apart.
 */

import { inspect } from "node:util";

import { fieldDecorator, type FieldDecorator, type TypeSpec } from "./decorators.js";

const MARKER = "(sensitive)";

/** A secret value, printed as `(sensitive)` and read only through `reveal`. */
export interface Sensitive<T> {
  /** The real value, or undefined when it was masked before it reached this program. */
  reveal(): T | undefined;
  /** Whether the value was masked before it reached this program. */
  readonly isRedacted: boolean;
  /** Always `(sensitive)`. */
  toString(): string;
  /** Always `(sensitive)`. */
  toJSON(): string;
}

class SensitiveValue<T> implements Sensitive<T> {
  readonly #value: T | undefined;
  readonly #redacted: boolean;

  constructor(value: T | undefined, redacted: boolean) {
    this.#value = value;
    this.#redacted = redacted;
  }

  reveal(): T | undefined {
    return this.#redacted ? undefined : this.#value;
  }

  get isRedacted(): boolean {
    return this.#redacted;
  }

  toString(): string {
    return MARKER;
  }

  toJSON(): string {
    return MARKER;
  }

  [inspect.custom](): string {
    return MARKER;
  }
}

/** The options of a sensitive field. */
export interface SensitiveOptions {
  /** The field can be left out of configuration. */
  optional?: boolean;
}

/** Builds a secret value, or declares a sensitive field. */
export interface SensitiveFunction {
  /** A value holding `value`. */
  new <T>(value: T): Sensitive<T>;
  /** A value whose real value was masked before it reached this program. */
  redacted<T>(): Sensitive<T>;
  /** Declares a sensitive attribute: masked in events and state. */
  (type: TypeSpec, options?: SensitiveOptions): FieldDecorator;
}

function SensitiveImpl(this: unknown, first: unknown, options?: SensitiveOptions): unknown {
  if (new.target !== undefined) {
    return new SensitiveValue(first, false);
  }
  return fieldDecorator({ kind: "sensitive", type: first as TypeSpec, optional: options?.optional ?? false });
}

(SensitiveImpl as unknown as { redacted: unknown }).redacted = (): Sensitive<never> => new SensitiveValue<never>(undefined, true);

/** The wrapper of a secret value and the decorator of a sensitive field. */
export const Sensitive = SensitiveImpl as unknown as SensitiveFunction;

/** Whether `value` is a `Sensitive`. */
export function isSensitive(value: unknown): value is Sensitive<unknown> {
  return value instanceof SensitiveValue;
}
