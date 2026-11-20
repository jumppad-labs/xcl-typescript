/**
 * `Entity` and `Meta` each name a decorator and a type: `@Entity("app")` and
 * the generic entity a lookup returns, `@Meta()` and the block's metadata.
 */

import { entityDecorator, metaDecorator, type ClassDecorator, type FieldDecorator } from "./decorators.js";
import type { Entity as EntityType, Meta as MetaType } from "./hydrate.js";

/** An entity of a type no class was registered for, such as a Go plugin's. */
export type Entity = EntityType;

/**
 * Names an entity class's block type and optional subtype.
 *
 * The decorator itself never throws. Registering a class with no `@Entity`, or
 * with an empty type, throws {@link SchemaError}.
 *
 * @param type The block type, the block's first label.
 * @param subtype The block subtype, its second label, or empty for a type with none.
 * @returns A class decorator recording the type and subtype against the class.
 */
export const Entity: (type: string, subtype?: string) => ClassDecorator = entityDecorator;

/** What the engine records about every entity: its address and where it was declared. */
export type Meta = MetaType;

/**
 * Declares the field that receives the block's metadata.
 *
 * @returns A decorator recording the field as the one hydration fills with the entity's `Meta`.
 */
export const Meta: () => FieldDecorator = metaDecorator;
