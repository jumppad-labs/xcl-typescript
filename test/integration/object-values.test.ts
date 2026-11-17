/**
 * Object values, attributes whose type is a class, decoded, reported, saved,
 * loaded and written back as configuration by the real engine. Every expected
 * text is Go's, written by hand from what xcl prints for a Go type declaring
 * the same fields for the same configuration.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { Attribute, Computed, Config, ConfigError, Entity, type Event, EventDataLevel, Int, LocalRegistry, Meta, prettylog, printDiff, Sensitive } from "../../src/index.js";
import { aes256gcm } from "../../src/mask.js";
import { isSensitive } from "../../src/sensitive.js";
import { isolateHome, missingEngine, testDirectory, writeConfig } from "../helpers/engine.js";
import { missingBuild, runScenario, SDK_MODULE } from "../helpers/script.js";

const needsEngine = missingEngine();
const needsBuild = needsEngine || missingBuild();
isolateHome();

/** An object nested inside another object value. */
class Upstream {
  @Attribute(String) host!: string;
}

/** An object value with a required field, a defaulted field and an optional field with no default. */
class Endpoint {
  @Attribute(Int) port!: number;
  @Attribute(Boolean) tls = false;
  @Attribute(String, { optional: true }) path?: string;
}

/** An object value holding a sensitive field, a computed field and a nested object. */
class Backend {
  @Attribute(Int) port!: number;
  @Sensitive(String, { optional: true }) token?: Sensitive<string>;
  @Computed(String) address?: string;
  @Attribute(() => Upstream, { optional: true }) upstream?: Upstream;
}

@Entity("app")
class App {
  @Meta() meta!: Meta;
  @Attribute(String) image!: string;
  @Attribute(() => Endpoint, { optional: true }) defaultEndpoint?: Endpoint;
  @Attribute([() => Endpoint], { optional: true }) endpoints: Endpoint[] = [];
  @Attribute({ map: () => Endpoint }, { optional: true }) routes: Record<string, Endpoint> = {};
  @Attribute(() => Backend, { optional: true }) backend?: Backend;
  @Computed(() => Endpoint) assigned?: Endpoint;
}

function registry(): LocalRegistry {
  const local = new LocalRegistry();
  local.register(App);
  return local;
}

async function open(t: TestContext, text: string): Promise<{ config: Config; path: string; directory: string }> {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", text);
  const config = await new Config({ registries: [registry()], statePath: join(directory, "state") }).setup();
  t.after(() => config.close());
  return { config, path, directory };
}

async function applied(t: TestContext, text: string): Promise<Config> {
  const { config, path } = await open(t, text);
  await config.apply(path);
  return config;
}

async function failure(operation: Promise<unknown>): Promise<ConfigError> {
  const error = await operation.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof ConfigError, `the error was: ${String(error)}`);
  return error;
}

function successOf(events: Event[], resourceId: string): Event | undefined {
  return events.find((event) => event.resourceId === resourceId && event.operation === "create" && event.phase === "success");
}

/** Every kind of object value, set in one entity. */
const EVERY_KIND = `app "web" {
  image            = "nginx"
  default_endpoint = { port = 80, tls = true }
  endpoints        = [{ port = 8080 }, { port = 8443, tls = true }]
  routes = {
    http  = { port = 80 }
    https = { port = 443, tls = true }
  }
  backend = {
    port     = 443
    token    = "s3cret"
    upstream = { host = "api.internal" }
  }
}
`;

/** An object value with a reference in it and a sensitive value, for encoding and printing. */
const ENCODED = `variable "port" {
  default = 80
}

app "web" {
  image            = "nginx"
  default_endpoint = { port = variable.port, tls = true }
  backend = {
    port     = 443
    token    = "s3cret"
    upstream = { host = "api.internal" }
  }
}
`;

// --- decoding a single object value

test("an object value setting every field decodes into an instance of its class holding both values", { skip: needsEngine }, async (t) => {
  const config = await applied(
    t,
    `app "web" {
  image            = "nginx"
  default_endpoint = { port = 80, tls = true }
}
`,
  );

  const web = await config.find(App, "app.web");

  assert.ok(web.defaultEndpoint instanceof Endpoint);
  assert.equal(web.defaultEndpoint.port, 80);
  assert.equal(web.defaultEndpoint.tls, true);
});

test("an object value leaving out a defaulted field gives that field its default", { skip: needsEngine }, async (t) => {
  const config = await applied(
    t,
    `app "web" {
  image            = "nginx"
  default_endpoint = { port = 80 }
}
`,
  );

  const web = await config.find(App, "app.web");

  assert.ok(web.defaultEndpoint instanceof Endpoint);
  assert.equal(web.defaultEndpoint.port, 80);
  assert.equal(web.defaultEndpoint.tls, false);
});

test("an object value leaving out an optional field with no default leaves that field unset", { skip: needsEngine }, async (t) => {
  const config = await applied(
    t,
    `app "web" {
  image            = "nginx"
  default_endpoint = { port = 80 }
}
`,
  );

  const web = await config.find(App, "app.web");

  assert.equal(web.defaultEndpoint?.path, undefined);
});

test("an optional object attribute left out of the block is unset", { skip: needsEngine }, async (t) => {
  const config = await applied(
    t,
    `app "web" {
  image = "nginx"
}
`,
  );

  const web = await config.find(App, "app.web");

  assert.equal(web.defaultEndpoint, undefined);
});

// --- a required field left out of an object value

// Go's validate checks structure without decoding values, so the missing
// field is reported by apply, as it is from Go
test("at the apply stage, an object value leaving out a required field is reported naming it at the value's position with Go's text", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `app "web" {
  image            = "nginx"
  default_endpoint = { tls = true }
}
`,
  );

  const error = await failure(config.apply(path));

  assert.equal(error.problems.length, 1);
  const problem = error.problems[0];
  assert.equal(problem?.file, path);
  assert.equal(problem?.line, 3);
  assert.equal(problem?.column, 22);
  assert.equal(problem?.summary, "Unsuitable value type");
  assert.equal(problem?.detail, 'Attribute "default_endpoint": Unsuitable value: attribute "port" is required');
  assert.equal(problem?.entity, "app.web");
  assert.equal(problem?.field, "default_endpoint");
});

test("at the validate stage, an object value leaving out a required field is not reported, as Go's validate does not decode values", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `app "web" {
  image            = "nginx"
  default_endpoint = { tls = true }
}
`,
  );

  await config.validate(path);
});

// --- an object attribute written as a block

// Go's text has no "Did you mean to define argument" suffix here: an entity
// type holds ResourceBase as a remain field, so gohcl.CheckBody
// (xcl internal/xcl/gohcl/check.go, checkBodyAgainstStruct) reads the body
// with PartialContent and reports the leftover block against the remain
// type's schema, which has no default_endpoint attribute for
// hclsyntax/structure.go to suggest. Go's own parity test asserts the same
// bare text for the unsupported_block fixture
// (xcl bindings/libxcl/cmd/parity/main_test.go, "Blocks of type \"timeout\" are not expected here.").

test("at the validate stage, an object attribute written as a nested block is refused with Go's text", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `app "web" {
  image = "nginx"
  default_endpoint {
    port = 80
  }
}
`,
  );

  const error = await failure(config.validate(path));

  assert.equal(error.problems.length, 1);
  const problem = error.problems[0];
  assert.equal(problem?.file, path);
  assert.equal(problem?.line, 3);
  assert.equal(problem?.column, 3);
  assert.equal(problem?.summary, "Unsupported block type");
  assert.equal(problem?.detail, 'Blocks of type "default_endpoint" are not expected here.');
  assert.equal(problem?.entity, "app.web");
  assert.equal(problem?.field, "default_endpoint[0]");
});

// --- sensitive, computed and nested fields inside an object value

test("an object's sensitive value is a sensitive value that reveals nothing from a lookup", { skip: needsEngine }, async (t) => {
  const config = await applied(t, EVERY_KIND);

  const web = await config.find(App, "app.web");

  assert.ok(isSensitive(web.backend?.token));
  assert.equal(web.backend.token.isRedacted, true);
  assert.equal(`${web.backend.token}`, "(sensitive)");
  assert.equal(web.backend.token.reveal(), undefined);
});

test("an object's sensitive value is redacted in an event's data", { skip: needsEngine }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", EVERY_KIND);
  const events: Event[] = [];
  const config = await new Config({
    registries: [registry()],
    statePath: join(directory, "state"),
    eventData: EventDataLevel.Processed,
    onEvent: (event) => {
      events.push(event);
    },
  }).setup();
  t.after(() => config.close());

  await config.apply(path);

  const data = successOf(events, "app.web")?.data;
  assert.ok(data, "the create success event carried no data");
  const text = new TextDecoder().decode(data);
  assert.match(text, /"backend":\{"port":443,"token":\{"xcl_masked":"redact","value":"\(sensitive\)"\}/);
  assert.doesNotMatch(text, /s3cret/);
});

test("an object's sensitive value is masked in state when a state mask is set", { skip: needsEngine }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", EVERY_KIND);
  const state = join(directory, "state");
  const config = await new Config({ registries: [registry()], statePath: state, stateMask: aes256gcm(new Uint8Array(32).fill(2)) }).setup();
  t.after(() => config.close());

  await config.apply(path);

  const raw = readFileSync(join(state, "state.json"), "utf8");
  const records = JSON.parse(raw) as { meta: { id: string }; backend: { port: number; token: { xcl_masked: string } } }[];
  const web = records.find((record) => record.meta.id === "app.web");
  assert.equal(web?.backend.port, 443);
  assert.equal(web?.backend.token.xcl_masked, "aes-256-gcm");
  assert.doesNotMatch(raw, /s3cret/);
});

test("an object's nested object is an instance of its class", { skip: needsEngine }, async (t) => {
  const config = await applied(t, EVERY_KIND);

  const web = await config.find(App, "app.web");

  assert.ok(web.backend instanceof Backend);
  assert.ok(web.backend.upstream instanceof Upstream);
  assert.equal(web.backend.upstream.host, "api.internal");
});

// A TypeScript entity type has no provider to fill a computed field in: the
// package has no provider or lifecycle API, and the engine handles a
// registered type without a provider (xcl internal/parser/lifecycle.go,
// handledWithoutProvider). So after an apply a
// computed value holds nothing, as a top-level computed field does
// (print.test.ts, encoding.test.ts). What a provider would fill in is shown
// by a record carrying the value, which encodes as Go's does.
test("an object's computed value is unset after an apply, with no provider to fill it in", { skip: needsEngine }, async (t) => {
  const config = await applied(t, EVERY_KIND);

  const web = await config.find(App, "app.web");

  assert.equal(web.backend?.address, undefined);
});

test("at the validate stage, an object value setting a computed field is refused with Go's text", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `app "web" {
  image   = "nginx"
  backend = { port = 443, address = "10.0.0.1:443" }
}
`,
  );

  const error = await failure(config.validate(path));

  assert.equal(error.problems.length, 1);
  const problem = error.problems[0];
  assert.equal(problem?.file, path);
  assert.equal(problem?.line, 3);
  assert.equal(problem?.summary, "Computed field set");
  assert.equal(problem?.detail, "resource 'app.web' sets computed field 'backend.address', computed fields are set by the provider and cannot be configured");
  assert.equal(problem?.entity, "app.web");
  assert.equal(problem?.field, "backend");
});

test("at the validate stage, setting a computed object attribute is refused with Go's text", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `app "web" {
  image    = "nginx"
  assigned = { port = 8080 }
}
`,
  );

  const error = await failure(config.validate(path));

  assert.equal(error.problems.length, 1);
  const problem = error.problems[0];
  assert.equal(problem?.file, path);
  assert.equal(problem?.line, 3);
  assert.equal(problem?.column, 3);
  assert.equal(problem?.summary, "Computed field set");
  assert.equal(problem?.detail, "resource 'app.web' sets computed field 'assigned', computed fields are set by the provider and cannot be configured");
  assert.equal(problem?.field, "assigned");
});

test("a record carrying a computed value inside an object encodes it with includeComputed, as Go's does", { skip: needsEngine }, async (t) => {
  const { config } = await open(t, EVERY_KIND);
  const record = JSON.stringify({ meta: { id: "app.web", name: "web", type: "app" }, image: "nginx", backend: { port: 443, address: "10.0.0.1:443" } });

  const text = await config.encodeSavedEntity(record, { includeComputed: true });

  assert.equal(text, 'app "web" {\n  image = "nginx"\n  backend = {\n    address = "10.0.0.1:443"\n    port    = 443\n  }\n}\n');
});

test("a record carrying a computed value inside an object leaves it out without includeComputed, as Go's does", { skip: needsEngine }, async (t) => {
  const { config } = await open(t, EVERY_KIND);
  const record = JSON.stringify({ meta: { id: "app.web", name: "web", type: "app" }, image: "nginx", backend: { port: 443, address: "10.0.0.1:443" } });

  const text = await config.encodeSavedEntity(record);

  assert.equal(text, 'app "web" {\n  image = "nginx"\n  backend = {\n    port = 443\n  }\n}\n');
});

test("a record carrying a computed object value encodes it as set by the provider, as Go's does", { skip: needsEngine }, async (t) => {
  const { config } = await open(t, EVERY_KIND);
  const record = JSON.stringify({ meta: { id: "app.web", name: "web", type: "app" }, image: "nginx", assigned: { port: 8080, tls: true } });

  const text = await config.encodeSavedEntity(record, { includeComputed: true });

  assert.equal(text, 'app "web" {\n  image = "nginx"\n  assigned = {\n    port = 8080\n    tls  = true\n  } # set by the provider\n}\n');
});

test("a hand-built entity with a computed value inside an object encodes it with includeComputed", { skip: needsEngine }, async (t) => {
  const { config } = await open(t, EVERY_KIND);
  const draft = new App();
  draft.meta = { name: "web" };
  draft.image = "nginx";
  draft.backend = new Backend();
  draft.backend.port = 443;
  draft.backend.address = "10.0.0.1:443";

  const text = await config.encodeEntity(draft, { includeComputed: true });

  // the class's empty list and map are values the draft holds, so Go writes them
  assert.equal(text, 'app "web" {\n  image     = "nginx"\n  endpoints = []\n  routes    = {}\n  backend = {\n    address = "10.0.0.1:443"\n    port    = 443\n  }\n}\n');
});

// --- lists and maps of object values

test("a list of object values decodes in order, each an instance of its class", { skip: needsEngine }, async (t) => {
  const config = await applied(t, EVERY_KIND);

  const web = await config.find(App, "app.web");

  assert.equal(web.endpoints.length, 2);
  assert.ok(web.endpoints[0] instanceof Endpoint);
  assert.ok(web.endpoints[1] instanceof Endpoint);
  assert.equal(web.endpoints[0].port, 8080);
  assert.equal(web.endpoints[0].tls, false);
  assert.equal(web.endpoints[1].port, 8443);
  assert.equal(web.endpoints[1].tls, true);
});

test("a map of object values decodes by key, each an instance of its class", { skip: needsEngine }, async (t) => {
  const config = await applied(t, EVERY_KIND);

  const web = await config.find(App, "app.web");

  assert.deepEqual(Object.keys(web.routes).sort(), ["http", "https"]);
  assert.ok(web.routes.http instanceof Endpoint);
  assert.ok(web.routes.https instanceof Endpoint);
  assert.equal(web.routes.http.port, 80);
  assert.equal(web.routes.http.tls, false);
  assert.equal(web.routes.https.port, 443);
  assert.equal(web.routes.https.tls, true);
});

test("at the apply stage, a list element leaving out a required field is reported naming it and the element with Go's text", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `app "web" {
  image     = "nginx"
  endpoints = [{ port = 80 }, { tls = true }]
}
`,
  );

  const error = await failure(config.apply(path));

  assert.equal(error.problems.length, 1);
  const problem = error.problems[0];
  assert.equal(problem?.file, path);
  assert.equal(problem?.line, 3);
  assert.equal(problem?.column, 15);
  assert.equal(problem?.summary, "Unsuitable value type");
  assert.equal(problem?.detail, 'Attribute "endpoints": Unsuitable value: element 1: attribute "port" is required');
  assert.equal(problem?.field, "endpoints");
});

test("at the apply stage, a map element leaving out a required field is reported naming it and the element with Go's text", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `app "web" {
  image  = "nginx"
  routes = { http = { port = 80 }, https = { tls = true } }
}
`,
  );

  const error = await failure(config.apply(path));

  assert.equal(error.problems.length, 1);
  const problem = error.problems[0];
  assert.equal(problem?.file, path);
  assert.equal(problem?.line, 3);
  assert.equal(problem?.column, 12);
  assert.equal(problem?.summary, "Unsuitable value type");
  assert.equal(problem?.detail, 'Attribute "routes": Unsuitable value: element "https": attribute "port" is required');
  assert.equal(problem?.field, "routes");
});

// --- the same values after apply, after a load in a new process and from an event

test("after an apply, a lookup gives back every object value", { skip: needsEngine }, async (t) => {
  const config = await applied(t, EVERY_KIND);

  const web = await config.find(App, "app.web");

  assert.ok(web.defaultEndpoint instanceof Endpoint);
  assert.deepEqual({ ...web.defaultEndpoint }, { port: 80, tls: true, path: undefined });
  assert.deepEqual(
    web.endpoints.map((endpoint) => ({ ...endpoint })),
    [
      { port: 8080, tls: false, path: undefined },
      { port: 8443, tls: true, path: undefined },
    ],
  );
  assert.deepEqual({ ...web.routes.http }, { port: 80, tls: false, path: undefined });
  assert.deepEqual({ ...web.routes.https }, { port: 443, tls: true, path: undefined });
  assert.equal(web.backend?.port, 443);
  assert.equal(`${web.backend?.token}`, "(sensitive)");
  assert.ok(web.backend?.upstream instanceof Upstream);
  assert.equal(web.backend.upstream.host, "api.internal");
});

test("an event's entity data gives back every object value", { skip: needsEngine }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", EVERY_KIND);
  const events: Event[] = [];
  const config = await new Config({
    registries: [registry()],
    statePath: join(directory, "state"),
    eventData: EventDataLevel.Processed,
    onEvent: (event) => {
      events.push(event);
    },
  }).setup();
  t.after(() => config.close());

  await config.apply(path);
  const web = successOf(events, "app.web")?.entity(App);

  assert.ok(web instanceof App);
  assert.ok(web.defaultEndpoint instanceof Endpoint);
  assert.deepEqual({ ...web.defaultEndpoint }, { port: 80, tls: true, path: undefined });
  assert.ok(web.endpoints[0] instanceof Endpoint);
  assert.deepEqual(
    web.endpoints.map((endpoint) => ({ ...endpoint })),
    [
      { port: 8080, tls: false, path: undefined },
      { port: 8443, tls: true, path: undefined },
    ],
  );
  assert.ok(web.routes.https instanceof Endpoint);
  assert.deepEqual({ ...web.routes.http }, { port: 80, tls: false, path: undefined });
  assert.deepEqual({ ...web.routes.https }, { port: 443, tls: true, path: undefined });
  assert.equal(web.backend?.port, 443);
  assert.ok(isSensitive(web.backend?.token));
  assert.equal(web.backend.token.isRedacted, true);
  assert.ok(web.backend.upstream instanceof Upstream);
  assert.equal(web.backend.upstream.host, "api.internal");
});

// the scenario is plain JavaScript, so it calls the decorators in their legacy form
const SCENARIO_APP = `import { Attribute, Computed, Config, Entity, Int, LocalRegistry, Meta, Sensitive } from ${JSON.stringify(SDK_MODULE)};
class Upstream {
  host;
}
Attribute(String)(Upstream.prototype, "host");
class Endpoint {
  port;
  tls = false;
  path;
}
Attribute(Int)(Endpoint.prototype, "port");
Attribute(Boolean)(Endpoint.prototype, "tls");
Attribute(String, { optional: true })(Endpoint.prototype, "path");
class Backend {
  port;
  token;
  address;
  upstream;
}
Attribute(Int)(Backend.prototype, "port");
Sensitive(String, { optional: true })(Backend.prototype, "token");
Computed(String)(Backend.prototype, "address");
Attribute(() => Upstream, { optional: true })(Backend.prototype, "upstream");
class App {
  meta;
  image;
  defaultEndpoint;
  endpoints = [];
  routes = {};
  backend;
  assigned;
}
Meta()(App.prototype, "meta");
Attribute(String)(App.prototype, "image");
Attribute(() => Endpoint, { optional: true })(App.prototype, "defaultEndpoint");
Attribute([() => Endpoint], { optional: true })(App.prototype, "endpoints");
Attribute({ map: () => Endpoint }, { optional: true })(App.prototype, "routes");
Attribute(() => Backend, { optional: true })(App.prototype, "backend");
Computed(() => Endpoint)(App.prototype, "assigned");
Entity("app")(App);
const local = new LocalRegistry();
local.register(App);`;

test("a load in a new process gives back every object value saved by an apply", { skip: needsBuild }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", EVERY_KIND);
  const state = join(directory, "state");
  {
    await using config = await new Config({ registries: [registry()], statePath: state }).setup();
    await config.apply(path);
  }

  const script = await runScenario(
    `${SCENARIO_APP}
const config = await new Config({ registries: [local], statePath: ${JSON.stringify(state)} }).setup();
await config.load();
const web = await config.find(App, "app.web");
console.log("defaultEndpointClass:" + (web.defaultEndpoint instanceof Endpoint));
console.log("defaultEndpoint:" + JSON.stringify(web.defaultEndpoint));
console.log("endpointClasses:" + web.endpoints.map((endpoint) => endpoint instanceof Endpoint).join(","));
console.log("endpoints:" + JSON.stringify(web.endpoints));
console.log("routeClasses:" + Object.keys(web.routes).sort().map((key) => key + "=" + (web.routes[key] instanceof Endpoint)).join(","));
console.log("routes:" + JSON.stringify({ http: web.routes.http, https: web.routes.https }));
console.log("backendPort:" + web.backend.port);
console.log("backendToken:" + String(web.backend.token));
console.log("upstreamClass:" + (web.backend.upstream instanceof Upstream));
console.log("upstreamHost:" + web.backend.upstream.host);
await config.close();
`,
    directory,
  );

  assert.equal(script.exitCode, 0, script.stderr);
  assert.equal(script.values("defaultEndpointClass:")[0], "true");
  assert.equal(script.values("defaultEndpoint:")[0], '{"port":80,"tls":true}');
  assert.equal(script.values("endpointClasses:")[0], "true,true");
  assert.equal(script.values("endpoints:")[0], '[{"port":8080,"tls":false},{"port":8443,"tls":true}]');
  assert.equal(script.values("routeClasses:")[0], "http=true,https=true");
  assert.equal(script.values("routes:")[0], '{"http":{"port":80,"tls":false},"https":{"port":443,"tls":true}}');
  assert.equal(script.values("backendPort:")[0], "443");
  assert.equal(script.values("backendToken:")[0], "(sensitive)");
  assert.equal(script.values("upstreamClass:")[0], "true");
  assert.equal(script.values("upstreamHost:")[0], "api.internal");
});

// --- encoding, printing, the pretty log and diffs

/** Go's text for the entity applied from ENCODED, under each choice. */
const ENCODED_EXPECTED = {
  none: `app "web" {
  image = "nginx"
  default_endpoint = {
    port = 80
    tls  = true
  }
  backend = {
    port  = 443
    token = "(sensitive)"
    upstream = {
      host = "api.internal"
    }
  }
}
`,
  empty: `app "web" {
  image = "nginx"
  default_endpoint = {
    path = ""
    port = 80
    tls  = true
  }
  endpoints = []
  routes    = {}
  backend = {
    port  = 443
    token = "(sensitive)"
    upstream = {
      host = "api.internal"
    }
  }
}
`,
  reveal: `app "web" {
  image = "nginx"
  default_endpoint = {
    port = 80
    tls  = true
  }
  backend = {
    port  = 443
    token = "s3cret"
    upstream = {
      host = "api.internal"
    }
  }
}
`,
  references: `app "web" {
  image            = "nginx"
  default_endpoint = { port = variable.port, tls = true }
  backend = {
    port  = 443
    token = "(sensitive)"
    upstream = {
      host = "api.internal"
    }
  }
}
`,
  all: `app "web" {
  image            = "nginx"
  default_endpoint = { port = variable.port, tls = true }
  endpoints        = []
  routes           = {}
  backend = {
    address = ""
    port    = 443
    token   = "s3cret"
    upstream = {
      host = "api.internal"
    }
  }
  assigned = {
    path = ""
    port = 0
    tls  = false
  } # set by the provider
}
`,
};

test("encoding an entity holding object values gives Go's text", { skip: needsEngine }, async (t) => {
  const config = await applied(t, ENCODED);
  const web = await config.find(App, "app.web");

  assert.equal(await config.encodeEntity(web), ENCODED_EXPECTED.none);
});

test("encoding an entity holding object values with includeComputed gives Go's text", { skip: needsEngine }, async (t) => {
  const config = await applied(t, ENCODED);
  const web = await config.find(App, "app.web");

  // the computed fields hold nothing after an apply, so only includeEmpty would write them
  assert.equal(await config.encodeEntity(web, { includeComputed: true }), ENCODED_EXPECTED.none);
});

test("encoding an entity holding object values with includeEmpty gives Go's text", { skip: needsEngine }, async (t) => {
  const config = await applied(t, ENCODED);
  const web = await config.find(App, "app.web");

  assert.equal(await config.encodeEntity(web, { includeEmpty: true }), ENCODED_EXPECTED.empty);
});

test("encoding an entity holding object values with revealSensitive gives Go's text", { skip: needsEngine }, async (t) => {
  const config = await applied(t, ENCODED);
  const web = await config.find(App, "app.web");

  assert.equal(await config.encodeEntity(web, { revealSensitive: true }), ENCODED_EXPECTED.reveal);
});

test("encoding an entity holding object values with showReferences gives Go's text", { skip: needsEngine }, async (t) => {
  const config = await applied(t, ENCODED);
  const web = await config.find(App, "app.web");

  assert.equal(await config.encodeEntity(web, { showReferences: true }), ENCODED_EXPECTED.references);
});

test("encoding an entity holding object values with all four choices gives Go's text", { skip: needsEngine }, async (t) => {
  const config = await applied(t, ENCODED);
  const web = await config.find(App, "app.web");

  assert.equal(await config.encodeEntity(web, { includeComputed: true, includeEmpty: true, revealSensitive: true, showReferences: true }), ENCODED_EXPECTED.all);
});

test("a field changed inside a looked-up object value is encoded with its new value", { skip: needsEngine }, async (t) => {
  const config = await applied(t, ENCODED);
  const web = await config.find(App, "app.web");

  assert.ok(web.defaultEndpoint);
  web.defaultEndpoint.port = 8080;

  assert.equal(
    await config.encodeEntity(web),
    `app "web" {
  image = "nginx"
  default_endpoint = {
    port = 8080
    tls  = true
  }
  backend = {
    port  = 443
    token = "(sensitive)"
    upstream = {
      host = "api.internal"
    }
  }
}
`,
  );
});

test("a hand-built entity holding object values encodes as configuration", { skip: needsEngine }, async (t) => {
  const { config } = await open(t, ENCODED);
  const draft = new App();
  draft.meta = { name: "web" };
  draft.image = "nginx";
  draft.defaultEndpoint = new Endpoint();
  draft.defaultEndpoint.port = 80;
  draft.defaultEndpoint.tls = true;
  const second = new Endpoint();
  second.port = 8443;
  second.tls = true;
  const first = new Endpoint();
  first.port = 8080;
  draft.endpoints = [first, second];
  const http = new Endpoint();
  http.port = 80;
  draft.routes = { http };

  assert.equal(
    await config.encodeEntity(draft),
    `app "web" {
  image = "nginx"
  default_endpoint = {
    port = 80
    tls  = true
  }
  endpoints = [{
    port = 8080
    }, {
    port = 8443
    tls  = true
  }]
  routes = {
    http = {
      port = 80
    }
  }
}
`,
  );
});

test("printing an entity holding object values gives Go's text", { skip: needsEngine }, async (t) => {
  const config = await applied(t, ENCODED);
  const web = await config.find(App, "app.web");
  let text = "";

  await config.printEntity(web, { out: { write: (chunk) => (text += chunk) } });

  assert.equal(text, ENCODED_EXPECTED.none);
});

test("the pretty log writes an entity's object values beneath its creation line", { skip: needsEngine }, async (t) => {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", ENCODED);
  let text = "";
  const config = await new Config({
    registries: [registry()],
    statePath: join(directory, "state"),
    eventData: EventDataLevel.Processed,
    onEvent: prettylog.handler({ out: { write: (chunk: string) => (text += chunk) } }),
  }).setup();
  t.after(() => config.close());

  await config.apply(path);

  const lines = text.split("\n");
  const created = lines.findIndex((line) => line.includes(" INFO create success ") && line.includes(" resource=app.web "));
  assert.notEqual(created, -1, text);
  const block: string[] = [];
  for (const line of lines.slice(created + 1)) {
    if (!line.startsWith(" ")) {
      break;
    }
    block.push(line);
  }
  assert.equal(
    block.join("\n"),
    `  app "web" {
    image = "nginx"
    default_endpoint = {
      port = 80
      tls  = true
    }
    backend = {
      port  = 443
      token = "(sensitive)"
      upstream = {
        host = "api.internal"
      }
    }
  }`,
  );
});

// Go leaves a registered type, which has no provider, out of a diff (xcl
// internal/parser/lifecycle.go: decideResource returns early when
// handledWithoutProvider, which is true for every registered type; decide:
// "Resources without a provider take no part"), so a
// TypeScript type, which has none, lists no change however its values
// change. The same configuration and change with a Go type that has no
// provider gives Go's text below, which is what TypeScript must match.
test("a diff after changing one field inside an object value gives Go's text for a type with no provider", { skip: needsEngine }, async (t) => {
  const { config, path, directory } = await open(t, ENCODED);
  await config.apply(path);
  const changed = writeConfig(directory, "main.xcl", ENCODED.replace("port     = 443", "port     = 8443"));

  const diff = await config.diff(changed);
  let text = "";
  printDiff(diff, { out: { write: (chunk) => (text += chunk) } });

  assert.equal(diff.resource("app.web"), undefined);
  assert.equal(text, "Diff: no changes, 0 unchanged.\n");
});
