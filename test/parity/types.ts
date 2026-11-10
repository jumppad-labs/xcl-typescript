/**
 * The decorated classes equivalent to each parity fixture's `types.json`.
 *
 * The Go parity program registers the schema v1 documents of a fixture's
 * `types.json` directly. This side registers these classes, whose derived
 * schema must equal those documents, which `types.test.ts` checks.
 *
 * Several fixtures declare a type called `app` with different fields, so each
 * fixture has classes of its own, and a run registers only its fixture's.
 */

import { Attribute, Block, Blocks, Computed, Entity, Func, Int, Label, Meta, NamedBlocks, Sensitive, type EntityClass } from "../../src/index.js";

// -- basic_types --------------------------------------------------------------

@Entity("service")
export class BasicTypesService {
  @Meta() meta!: Meta;
  @Attribute(Int) port!: number;
  @Attribute(Number, { optional: true }) ratio?: number;
  @Attribute(Boolean, { optional: true }) enabled?: boolean;
  @Attribute([String], { optional: true }) tags?: string[];
  @Attribute({ map: String }, { optional: true }) labels?: Record<string, string>;
  @Attribute(String, { optional: true }) upstream?: string;
}

// -- annotations --------------------------------------------------------------

export class AnnotationsHealth {
  @Attribute(String) path!: string;
}

export class AnnotationsVolume {
  @Attribute(String) source!: string;
  @Label() name = "";
}

export class AnnotationsListener {
  @Attribute(Int) port!: number;
  @Label() name = "";
}

@Entity("app")
export class AnnotationsApp {
  @Meta() meta!: Meta;
  @Attribute(String) image!: string;
  @Attribute(Int) replicas = 2;
  @Attribute(String) region = "eu";
  @Sensitive(String, { optional: true }) password?: Sensitive<string>;
  @Computed(String) endpoint?: string;
  @Block(() => AnnotationsHealth, { optional: true }) health?: AnnotationsHealth;
  @Blocks(() => AnnotationsVolume) volume: AnnotationsVolume[] = [];
  @NamedBlocks(() => AnnotationsListener) listener: Record<string, AnnotationsListener> = {};
}

// -- functions ----------------------------------------------------------------

@Entity("app")
export class FunctionsApp {
  @Meta() meta!: Meta;
  @Attribute(String) name!: string;
  @Sensitive(String, { optional: true }) secret?: Sensitive<string>;
  @Sensitive(String, { optional: true }) token?: Sensitive<string>;
}

// -- variables ----------------------------------------------------------------

@Entity("app")
export class VariablesApp {
  @Meta() meta!: Meta;
  @Attribute(String) region!: string;
  @Attribute(Int, { optional: true }) replicas?: number;
}

// -- outputs ------------------------------------------------------------------

@Entity("app")
export class OutputsApp {
  @Meta() meta!: Meta;
  @Attribute(String) region!: string;
  @Attribute([Int], { optional: true }) ports?: number[];
}

// -- invalid ------------------------------------------------------------------

@Entity("app")
export class InvalidApp {
  @Meta() meta!: Meta;
  @Attribute(String) image!: string;
  @Computed(String) endpoint?: string;
}

// -- unsupported_block --------------------------------------------------------

@Entity("app")
export class UnsupportedBlockApp {
  @Meta() meta!: Meta;
  @Attribute(String) image!: string;
  @Computed(String) endpoint?: string;
}

// -- singletons ---------------------------------------------------------------

/** No label field and no metadata field: its block is written without labels. */
@Entity("runner")
export class SingletonsRunner {
  @Attribute(String) server!: string;
  @Attribute(String, { optional: true }) listen?: string;
}

@Entity("agent")
export class SingletonsAgent {
  @Attribute(String) model!: string;
  @Attribute(String, { optional: true }) server?: string;
  @Label() handle = "";
}

// -- encode -------------------------------------------------------------------

@Entity("store", "postgres")
export class EncodeStore {
  @Meta() meta!: Meta;
  @Attribute(String) address!: string;
  @Sensitive(String) password!: Sensitive<string>;
  @Attribute(String) note = "";
  @Attribute(Int, { optional: true }) port?: number;
  @Attribute([String]) tags: string[] = [];
  @Attribute({ map: String }, { optional: true }) labels?: Record<string, string>;
}

@Entity("service")
export class EncodeService {
  @Attribute(String) location!: string;
  @Sensitive(String, { optional: true }) secret?: Sensitive<string>;
  @Sensitive(String, { optional: true }) token?: Sensitive<string>;
  @Label() name = "";
}

/** A fixture directory's name to its classes, in the order of its `types.json`. */
export const FIXTURES: Readonly<Record<string, readonly EntityClass[]>> = {
  basic_types: [BasicTypesService],
  annotations: [AnnotationsApp],
  functions: [FunctionsApp],
  variables: [VariablesApp],
  outputs: [OutputsApp],
  plugin_entities: [],
  invalid: [InvalidApp],
  unsupported_block: [UnsupportedBlockApp],
  singletons: [SingletonsRunner, SingletonsAgent],
  encode: [EncodeStore, EncodeService],
};

function handBuiltStore(): EncodeStore {
  const store = new EncodeStore();
  store.address = "10.0.0.1";
  store.password = new Sensitive("s3cret");
  store.tags = [];
  store.meta = { name: "main" };
  return store;
}

/**
 * A fixture directory's name to the entities its `hand_built.json` lists, by
 * address, each built by hand with the values the fixture's `main.xcl` gives
 * it, never loaded.
 */
export const HAND_BUILT: Readonly<Record<string, Readonly<Record<string, () => object>>>> = {
  encode: {
    "store.postgres.main": handBuiltStore,
  },
};

/** The function every parity side registers: lower case, spaces to dashes. */
export class ParityFunctions {
  @Func([String], String)
  slugify(title: string): string {
    return title.toLowerCase().replaceAll(" ", "-");
  }
}
