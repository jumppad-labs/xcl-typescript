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

// -- object_values ------------------------------------------------------------

/** An object value's class: required, defaulted, optional and sensitive fields. */
export class ObjectValuesEndpoint {
  @Attribute(Int) port!: number;
  @Attribute(Boolean) tls = false;
  @Attribute(String, { optional: true }) path?: string;
  @Sensitive(String, { optional: true }) token?: Sensitive<string>;
}

@Entity("database", "postgres")
export class ObjectValuesPostgres {
  @Meta() meta!: Meta;
  @Attribute(String) location!: string;
  @Attribute(Int) port = 5432;
}

@Entity("app")
export class ObjectValuesApp {
  @Meta() meta!: Meta;
  @Attribute(String) image!: string;
  @Attribute(() => ObjectValuesEndpoint) defaultEndpoint!: ObjectValuesEndpoint;
  @Attribute([() => ObjectValuesEndpoint]) endpoints: ObjectValuesEndpoint[] = [];
  @Attribute({ map: () => ObjectValuesEndpoint }) routes: Record<string, ObjectValuesEndpoint> = {};
  @Attribute(() => ObjectValuesPostgres, { optional: true }) database?: ObjectValuesPostgres;
  @Attribute([() => ObjectValuesPostgres]) databases: ObjectValuesPostgres[] = [];
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
  object_values: [ObjectValuesPostgres, ObjectValuesApp],
};

function handBuiltStore(): EncodeStore {
  const store = new EncodeStore();
  store.address = "10.0.0.1";
  store.password = new Sensitive("s3cret");
  store.tags = [];
  store.meta = { name: "main" };
  return store;
}

function endpoint(port: number, tls = false, path?: string): ObjectValuesEndpoint {
  const built = new ObjectValuesEndpoint();
  built.port = port;
  built.tls = tls;
  if (path !== undefined) {
    built.path = path;
  }
  return built;
}

function postgres(name: string, location: string, port = 5432): ObjectValuesPostgres {
  const built = new ObjectValuesPostgres();
  built.meta = { name, type: "database", subtype: "postgres" };
  built.location = location;
  built.port = port;
  return built;
}

function handBuiltEdge(): ObjectValuesApp {
  const app = new ObjectValuesApp();
  app.meta = { name: "edge" };
  app.image = "envoy";
  app.defaultEndpoint = endpoint(443, true);
  app.routes = { public: endpoint(443, true, "/") };
  // main.xcl sets neither list, so they are unset rather than the class's empty default
  const unset = app as { endpoints?: unknown; databases?: unknown };
  unset.endpoints = undefined;
  unset.databases = undefined;
  return app;
}

function handBuiltWeb(): ObjectValuesApp {
  const app = new ObjectValuesApp();
  // the references main.xcl writes, which show references swaps in
  app.meta = { name: "web", references: { database: "database.postgres.main", databases: "[database.postgres.a, database.postgres.b]" } };
  app.image = "nginx";
  app.defaultEndpoint = endpoint(80, true);
  app.defaultEndpoint.token = new Sensitive("s3cret");
  app.endpoints = [endpoint(8080), endpoint(8443, true, "/api")];
  app.routes = { public: endpoint(80), admin: endpoint(9000, true) };
  app.database = postgres("main", "eu-west-1");
  app.databases = [postgres("a", "eu-west-2", 5433), postgres("b", "us-east-1")];
  return app;
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
  object_values: {
    "app.edge": handBuiltEdge,
    "database.postgres.main": () => postgres("main", "eu-west-1"),
    "app.web": handBuiltWeb,
  },
};

/** The function every parity side registers: lower case, spaces to dashes. */
export class ParityFunctions {
  @Func([String], String)
  slugify(title: string): string {
    return title.toLowerCase().replaceAll(" ", "-");
  }
}
