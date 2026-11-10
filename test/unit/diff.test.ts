import assert from "node:assert/strict";
import { test } from "node:test";

import { Diff, UNKNOWN } from "../../src/diff.js";

function diffOf(engineJson: unknown): Diff {
  return Diff.fromJSON(new TextEncoder().encode(JSON.stringify(engineJson)));
}

function changeOf(engineChange: unknown): Diff["resources"][number]["changes"][number] {
  const diff = diffOf({
    summary: { update: 1 },
    resources: [{ address: "resource.container.web", action: "update", changes: [engineChange] }],
  });
  const change = diff.resources[0]?.changes[0];
  assert.ok(change !== undefined);
  return change;
}

test("the summary reports each kind of change", () => {
  const diff = diffOf({ summary: { create: 1, update: 2, replace: 3, delete: 4, unchanged: 5 }, resources: [] });

  assert.deepEqual(diff.summary, { create: 1, update: 2, replace: 3, delete: 4, unchanged: 5 });
});

test("a kind of change the summary leaves out counts as zero", () => {
  const diff = diffOf({ summary: { create: 2 }, resources: [] });

  assert.deepEqual(diff.summary, { create: 2, update: 0, replace: 0, delete: 0, unchanged: 0 });
});

test("changed counts everything but the unchanged entities", () => {
  const diff = diffOf({ summary: { create: 1, update: 2, replace: 3, delete: 4, unchanged: 5 }, resources: [] });

  assert.equal(diff.changed(), 10);
});

test("changed is zero when every entity is unchanged", () => {
  const diff = diffOf({ summary: { unchanged: 5 }, resources: [] });

  assert.equal(diff.changed(), 0);
});

test("resource finds an entity's entry by address", () => {
  const diff = diffOf({
    summary: { create: 1, delete: 1 },
    resources: [
      { address: "resource.container.web", action: "create", reason: "new entity" },
      { address: "resource.container.old", action: "delete", reason: "removed" },
    ],
  });

  const found = diff.resource("resource.container.old");

  assert.equal(found?.address, "resource.container.old");
  assert.equal(found?.action, "delete");
  assert.equal(found?.reason, "removed");
});

test("resource is undefined for an address the apply leaves alone", () => {
  const diff = diffOf({
    summary: { create: 1 },
    resources: [{ address: "resource.container.web", action: "create" }],
  });

  assert.equal(diff.resource("resource.container.other"), undefined);
});

test("resources holds every entity in the engine's order", () => {
  const diff = diffOf({
    summary: { create: 1, delete: 1 },
    resources: [
      { address: "resource.container.web", action: "create" },
      { address: "resource.container.old", action: "delete" },
    ],
  });

  assert.deepEqual(
    diff.resources.map((resource) => resource.address),
    ["resource.container.web", "resource.container.old"],
  );
});

test("a resource's replaced dependencies are carried", () => {
  const diff = diffOf({
    summary: { replace: 1 },
    resources: [{ address: "resource.container.web", action: "replace", replaced_dependencies: ["resource.network.main"] }],
  });

  assert.deepEqual(diff.resource("resource.container.web")?.replacedDependencies, ["resource.network.main"]);
});

test("a resource's dependencies are carried with their action", () => {
  const diff = diffOf({
    summary: { update: 1 },
    resources: [
      {
        address: "resource.container.web",
        action: "update",
        dependencies: [{ address: "resource.network.main", action: "replace" }],
      },
    ],
  });

  assert.deepEqual(diff.resource("resource.container.web")?.dependencies, [{ address: "resource.network.main", action: "replace" }]);
});

test("a resource the engine says nothing else about has empty lists and strings", () => {
  const diff = diffOf({ summary: { create: 1 }, resources: [{ address: "resource.container.web" }] });

  assert.deepEqual(diff.resource("resource.container.web"), {
    address: "resource.container.web",
    action: "",
    reason: "",
    replacedDependencies: [],
    dependencies: [],
    changes: [],
  });
});

test("a change reports its old and new value", () => {
  const change = changeOf({ path: "image", before: "nginx:1.26", after: "nginx:1.27" });

  assert.equal(change.path, "image");
  assert.equal(change.before, "nginx:1.26");
  assert.equal(change.after, "nginx:1.27");
});

test("a change with a known value is not unknown", () => {
  const change = changeOf({ path: "image", before: "nginx:1.26", after: "nginx:1.27" });

  assert.equal(change.unknown, false);
  assert.notEqual(change.after, UNKNOWN);
});

test("a change's values can be structured", () => {
  const change = changeOf({ path: "env", before: { LOG_LEVEL: "info" }, after: { LOG_LEVEL: "debug", some_key: "value" } });

  assert.deepEqual(change.before, { LOG_LEVEL: "info" });
  assert.deepEqual(change.after, { LOG_LEVEL: "debug", some_key: "value" });
});

test("a change to null keeps null rather than the sentinel", () => {
  const change = changeOf({ path: "image", before: "nginx:1.26", after: null });

  assert.equal(change.after, null);
  assert.equal(change.unknown, false);
});

test("a value known only after apply is the UNKNOWN sentinel", () => {
  const change = changeOf({ path: "container_id", before: "abc123", unknown: true });

  assert.equal(change.after, UNKNOWN);
  assert.equal(change.unknown, true);
});

test("a change to an unknown value keeps its old value", () => {
  const change = changeOf({ path: "container_id", before: "abc123", unknown: true });

  assert.equal(change.before, "abc123");
});

test("a sensitive change says so", () => {
  const change = changeOf({ path: "password", before: "(sensitive)", after: "(sensitive)", sensitive: true });

  assert.equal(change.sensitive, true);
});

test("a change that is not sensitive says so", () => {
  const change = changeOf({ path: "image", before: "nginx:1.26", after: "nginx:1.27" });

  assert.equal(change.sensitive, false);
});

test("a change's path of one attribute is its name", () => {
  const change = changeOf({ path: "image", before: "a", after: "b" });

  assert.equal(change.path, "image");
});

test("a change's path converts an attribute after an index", () => {
  const change = changeOf({ path: "ports[0].host_port", before: 80, after: 8080 });

  assert.equal(change.path, "ports[0].hostPort");
});

test("a change's path keeps an upper-case map key", () => {
  const change = changeOf({ path: 'env["LOG_LEVEL"]', before: "info", after: "debug" });

  assert.equal(change.path, 'env["LOG_LEVEL"]');
});

test("a change's path keeps a snake_case map key", () => {
  const change = changeOf({ path: 'env["some_key"]', before: "a", after: "b" });

  assert.equal(change.path, 'env["some_key"]');
});

test("a change's path converts the attribute holding a map key", () => {
  const change = changeOf({ path: 'extra_env["some_key"]', before: "a", after: "b" });

  assert.equal(change.path, 'extraEnv["some_key"]');
});

test("raw is the engine's JSON as Go wrote it", () => {
  const engineJson = {
    summary: { create: 0, update: 1, replace: 0, delete: 0, unchanged: 2 },
    resources: [
      {
        address: "resource.container.web",
        action: "update",
        replaced_dependencies: ["resource.network.main"],
        changes: [{ path: "ports[0].host_port", before: 80, after: 8080 }],
      },
    ],
  };

  const diff = diffOf(engineJson);

  assert.deepEqual(diff.raw, engineJson);
});

test("empty diff JSON gives an empty diff", () => {
  const diff = Diff.fromJSON(new Uint8Array());

  assert.deepEqual(diff.summary, { create: 0, update: 0, replace: 0, delete: 0, unchanged: 0 });
  assert.equal(diff.changed(), 0);
  assert.deepEqual(diff.resources, []);
  assert.deepEqual(diff.raw, {});
});

test("an empty JSON object gives an empty diff", () => {
  const diff = diffOf({});

  assert.deepEqual(diff.summary, { create: 0, update: 0, replace: 0, delete: 0, unchanged: 0 });
  assert.equal(diff.changed(), 0);
  assert.deepEqual(diff.resources, []);
  assert.deepEqual(diff.raw, {});
});

test("an empty diff has no entry for any address", () => {
  const diff = diffOf({});

  assert.equal(diff.resource("resource.container.web"), undefined);
});
