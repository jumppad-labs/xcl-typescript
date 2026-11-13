/**
 * The same class definitions, compiled once with standard decorators and once
 * with legacy decorators, validate and apply the same configuration and return
 * the same entities. Each compiled tree carries its own copy of the SDK, so a
 * tree's classes are used with that tree's `Config`.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { isolateHome, missingEngine, ROOT, testDirectory, writeConfig } from "../helpers/engine.js";

isolateHome();

const CONFIG = `app "web" {
  image    = "nginx"
  password = "s3cret"

  health {
    path = "/healthz"
  }

  volume "data" {
    source = "/a"
  }

  listener "http" {
    port = 8080
  }
}

database "postgres" "main" {
  location = "eu"
}
`;

interface LoadedApp {
  image: string;
  replicas: number;
  meta: { id: string };
  health: { path: string; interval: number };
  volume: { name: string; source: string }[];
  listener: Record<string, { name: string; port: number }>;
  password: { isRedacted: boolean };
}

async function appliedIn(t: TestContext, mode: string): Promise<{ app: LoadedApp; appIsInstance: boolean; postgresLocation: string }> {
  const tree = join(ROOT, "build", `decorators-${mode}`);
  const sdk = (await import(pathToFileURL(join(tree, "src", "index.js")).href)) as Record<string, never>;
  const entities = (await import(pathToFileURL(join(tree, "test", "decorators", "entities.js")).href)) as Record<string, new () => object>;
  const { Config, LocalRegistry } = sdk as unknown as {
    Config: new (options: object) => {
      setup(): Promise<{
        validate(path: string): Promise<void>;
        apply(path: string): Promise<void>;
        find(type: unknown, address: string): Promise<object>;
        close(): Promise<void>;
      }>;
    };
    LocalRegistry: new () => { register(...classes: unknown[]): void };
  };

  const directory = testDirectory(t);
  const path = writeConfig(directory, "main.xcl", CONFIG);
  const local = new LocalRegistry();
  local.register(entities.App, entities.Postgres);
  const config = await new Config({ registries: [local], statePath: join(directory, "state") }).setup();
  t.after(() => config.close());

  await config.validate(path);
  await config.apply(path);
  const app = await config.find(entities.App, "app.web");
  const postgres = (await config.find(entities.Postgres, "database.postgres.main")) as { location: string };
  return { app: app as unknown as LoadedApp, appIsInstance: app instanceof (entities.App as new () => object), postgresLocation: postgres.location };
}

function missingTree(mode: string): string | false {
  return existsSync(join(ROOT, "build", `decorators-${mode}`, "test", "decorators", "entities.js")) ? false : `the ${mode} decorator build is missing; run npm run build:test`;
}

const needsStandard = missingEngine() || missingTree("standard");
const needsLegacy = missingEngine() || missingTree("legacy");

test("standard decorators validate, apply and return instances of the class", { skip: needsStandard }, async (t) => {
  const { app, appIsInstance, postgresLocation } = await appliedIn(t, "standard");

  assert.ok(appIsInstance);
  assert.equal(app.image, "nginx");
  assert.equal(app.replicas, 2);
  assert.equal(app.meta.id, "app.web");
  assert.equal(app.health.path, "/healthz");
  assert.equal(app.health.interval, 10);
  assert.equal(app.volume[0]?.name, "data");
  assert.equal(app.listener.http?.port, 8080);
  assert.equal(app.password.isRedacted, true);
  assert.equal(postgresLocation, "eu");
});

test("legacy decorators validate, apply and return instances of the class", { skip: needsLegacy }, async (t) => {
  const { app, appIsInstance, postgresLocation } = await appliedIn(t, "legacy");

  assert.ok(appIsInstance);
  assert.equal(app.image, "nginx");
  assert.equal(app.replicas, 2);
  assert.equal(app.meta.id, "app.web");
  assert.equal(app.health.path, "/healthz");
  assert.equal(app.health.interval, 10);
  assert.equal(app.volume[0]?.name, "data");
  assert.equal(app.listener.http?.port, 8080);
  assert.equal(app.password.isRedacted, true);
  assert.equal(postgresLocation, "eu");
});
