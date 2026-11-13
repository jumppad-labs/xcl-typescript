/** TypeScript functions called from configuration by the real engine. */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { Attribute, ConfigError, Config, Entity, Func, FunctionNameClashError, Int, LocalRegistry, Meta } from "../../src/index.js";
import { isolateHome, missingEngine, testDirectory, writeConfig } from "../helpers/engine.js";

const needsEngine = missingEngine();
isolateHome();

@Entity("app")
class App {
  @Meta() meta!: Meta;
  @Attribute(String) name!: string;
  @Attribute(Int) replicas = 1;
}

class Functions {
  @Func([String], String)
  slugify(title: string): string {
    return title.toLowerCase().replaceAll(" ", "-");
  }

  @Func([Int, Int], Int)
  async add(a: number, b: number): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return a + b;
  }

  @Func([String], String)
  broken(): string {
    throw new Error("slug service is down");
  }
}

function registry(): LocalRegistry {
  const local = new LocalRegistry();
  local.register(App);
  local.registerFunctions(new Functions());
  return local;
}

async function open(t: TestContext, text: string, local: LocalRegistry = registry()): Promise<{ config: Config; path: string }> {
  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", text);
  const config = await new Config({ registries: [local], statePath: join(directory, "state") }).setup();
  t.after(() => config.close());
  return { config, path };
}

test("a function's result is filled in", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `app "web" {
  name = slugify("My App")
}
`,
  );

  await config.apply(path);
  const web = await config.find(App, "app.web");

  assert.equal(web.name, "my-app");
});

test("an async function's resolved value is filled in", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `app "web" {
  name     = "x"
  replicas = add(2, 3)
}
`,
  );

  await config.apply(path);
  const web = await config.find(App, "app.web");

  assert.equal(web.replicas, 5);
});

test("a function's thrown error fails the configuration with that message", { skip: needsEngine }, async (t) => {
  const { config, path } = await open(
    t,
    `app "web" {
  name = broken("x")
}
`,
  );

  const error = await config.apply(path).then(
    () => undefined,
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof ConfigError, `the error was: ${String(error)}`);
  assert.match(`${error.message} ${error.problems.map((problem) => `${problem.summary} ${problem.detail}`).join(" ")}`, /slug service is down/);
});

test("a name a builtin uses is refused with the name-clash error", { skip: needsEngine }, async () => {
  class Clash {
    @Func([String], String)
    upper(text: string): string {
      return text;
    }
  }
  const local = new LocalRegistry();
  local.registerFunctions(new Clash());

  await assert.rejects(new Config({ registries: [local] }).setup(), FunctionNameClashError);
});

test("a name another function uses is refused with the name-clash error", { skip: needsEngine }, async () => {
  class One {
    @Func([], String, { name: "same" })
    first(): string {
      return "1";
    }
  }
  class Two {
    @Func([], String, { name: "same" })
    second(): string {
      return "2";
    }
  }
  const local = new LocalRegistry();
  local.registerFunctions(new One());
  local.registerFunctions(new Two());

  await assert.rejects(new Config({ registries: [local] }).setup(), FunctionNameClashError);
});
