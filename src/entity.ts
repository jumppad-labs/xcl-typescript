/**
 * `Entity` and `Meta` each name a decorator and a type: `@Entity("app")` and
 * the generic entity a lookup returns, `@Meta()` and the block's metadata.
 */

import { entityDecorator, metaDecorator, type ClassDecorator, type FieldDecorator } from "./decorators.js";
import type { Entity as EntityType, Meta as MetaType } from "./hydrate.js";

/** An entity of a type no class was registered for, such as a Go plugin's. */
export type Entity = EntityType;

/** Names an entity class's block type and optional subtype. */
export const Entity: (type: string, subtype?: string) => ClassDecorator = entityDecorator;

/** What the engine records about every entity: its address and where it was declared. */
export type Meta = MetaType;

/** Declares the field that receives the block's metadata. */
export const Meta: () => FieldDecorator = metaDecorator;
