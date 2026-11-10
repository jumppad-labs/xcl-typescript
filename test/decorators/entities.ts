/**
 * The classes both decorator compilations build. Nothing here may depend on
 * which mode compiles it: a type error under either mode fails the build.
 */

import { Func } from "../../src/decorators.js";
import { Any, Attribute, Block, Blocks, Computed, Int, Label, NamedBlocks } from "../../src/decorators.js";
import { Entity, Meta } from "../../src/entity.js";
import { Sensitive } from "../../src/sensitive.js";

export class Health {
  @Attribute(String) path = "/";
  @Attribute(Int) interval = 10;
}

export class Volume {
  @Label() name!: string;
  @Attribute(String) source!: string;
}

export class Listener {
  @Label() name!: string;
  @Attribute(Int) port!: number;
}

@Entity("app")
export class App {
  @Meta() meta!: Meta;
  @Attribute(String) image!: string;
  @Attribute(Int) replicas = 2;
  @Attribute(String, { optional: true }) region?: string;
  @Sensitive(String, { optional: true }) password?: Sensitive<string>;
  @Computed(String) endpoint?: string;
  @Block(() => Health, { optional: true }) health?: Health;
  @Blocks(() => Volume) volume: Volume[] = [];
  @NamedBlocks(() => Listener) listener: Record<string, Listener> = {};
}

@Entity("database", "postgres")
export class Postgres {
  @Meta() meta!: Meta;
  @Attribute(String) location!: string;
  @Attribute(Int) port = 5432;
}

/** A block class declaring one attribute of every type a field can have. */
export class TypeSpecs {
  @Attribute(String) text!: string;
  @Attribute(Number) ratio!: number;
  @Attribute(Boolean) enabled!: boolean;
  @Attribute(Int) count!: number;
  @Attribute(Any) anything: unknown;
  @Attribute([String]) tags: string[] = [];
  @Attribute({ map: String }) labels: Record<string, string> = {};
  @Attribute([[Int]]) grid: number[][] = [];
  @Attribute({ map: [String] }) groups: Record<string, string[]> = {};
  @Computed([String]) addresses?: string[];
  @Sensitive({ map: String }) credentials?: Sensitive<Record<string, string>>;
}

/** A block class with each field kind that takes an optional flag, with and without it. */
export class OptionalFlags {
  @Attribute(String) defaultAttribute!: string;
  @Attribute(String, { optional: false }) requiredAttribute!: string;
  @Attribute(String, { optional: true }) optionalAttribute?: string;
  @Sensitive(String) defaultSecret!: Sensitive<string>;
  @Sensitive(String, { optional: true }) optionalSecret?: Sensitive<string>;
  @Block(() => Health) defaultBlock!: Health;
  @Block(() => Health, { optional: true }) optionalBlock?: Health;
}

/** Refers to a class declared after it, which is what a block's thunk is for. */
export class ForwardReference {
  @Block(() => DeclaredLater) later!: DeclaredLater;
  @Blocks(() => DeclaredLater) many: DeclaredLater[] = [];
  @NamedBlocks(() => DeclaredLater) named: Record<string, DeclaredLater> = {};
}

export class DeclaredLater {
  @Attribute(String) value!: string;
}

/** Constructed only by the test that constructs a class twice. */
export class ConstructedTwice {
  @Attribute(String) first = "one";
  @Attribute(Int) second = 2;
}

export class BaseResource {
  @Attribute(String) name = "base";
  @Attribute(Int) retries = 3;
}

export class ChildResource extends BaseResource {
  @Attribute(Boolean) enabled = true;
}

export class GrandchildResource extends ChildResource {
  @Attribute(String) zone = "a";
}

export class OverridingResource extends BaseResource {
  @Computed(String) override name = "overridden";
  @Attribute(Boolean) enabled = true;
}

export class Functions {
  @Func([String], String)
  slugify(title: string): string {
    return title.toLowerCase().replaceAll(" ", "-");
  }

  @Func([String], String, { name: "shout" })
  async loud(text: string): Promise<string> {
    return text.toUpperCase();
  }
}
