import assert from "node:assert/strict";
import { test } from "node:test";

import { SchemaError } from "../../src/errors.js";
import { GitHubRegistry, LocalRegistry } from "../../src/registry.js";

test("an empty local registry has no plugins and no pattern", () => {
  const registry = new LocalRegistry();

  assert.deepEqual(registry.toProto(), {
    kind: {
      case: "local",
      value: {
        pluginPattern: "",
        types: [],
          functions: [],
        externalPluginCommands: [],
        pluginDirectories: [],
      },
    },
  });
});

test("an external plugin given by path is a command of one word", () => {
  const registry = new LocalRegistry();

  registry.registerExternalPlugin("/opt/plugins/xcl-plugin-docker");

  assert.deepEqual(registry.toProto(), {
    kind: {
      case: "local",
      value: {
        pluginPattern: "",
        types: [],
          functions: [],
        externalPluginCommands: [{ command: ["/opt/plugins/xcl-plugin-docker"] }],
        pluginDirectories: [],
      },
    },
  });
});

test("an external plugin given by argv keeps its program and arguments", () => {
  const registry = new LocalRegistry();

  registry.registerExternalPlugin(["python3", "-m", "my_plugin"]);

  assert.deepEqual(registry.toProto(), {
    kind: {
      case: "local",
      value: {
        pluginPattern: "",
        types: [],
          functions: [],
        externalPluginCommands: [{ command: ["python3", "-m", "my_plugin"] }],
        pluginDirectories: [],
      },
    },
  });
});

test("external plugins stay in the order they were registered", () => {
  const registry = new LocalRegistry();

  registry.registerExternalPlugin("/opt/plugins/first");
  registry.registerExternalPlugin(["/opt/plugins/second", "--flag"]);

  assert.deepEqual(registry.toProto(), {
    kind: {
      case: "local",
      value: {
        pluginPattern: "",
        types: [],
          functions: [],
        externalPluginCommands: [{ command: ["/opt/plugins/first"] }, { command: ["/opt/plugins/second", "--flag"] }],
        pluginDirectories: [],
      },
    },
  });
});

test("an argv changed after registering does not change the plugin", () => {
  const registry = new LocalRegistry();
  const argv = ["/opt/plugins/first"];

  registry.registerExternalPlugin(argv);
  argv.push("--added-later");

  assert.deepEqual(registry.toProto(), {
    kind: {
      case: "local",
      value: {
        pluginPattern: "",
        types: [],
          functions: [],
        externalPluginCommands: [{ command: ["/opt/plugins/first"] }],
        pluginDirectories: [],
      },
    },
  });
});

test("an empty argv throws SchemaError", () => {
  const registry = new LocalRegistry();

  assert.throws(() => registry.registerExternalPlugin([]), SchemaError);
});

test("plugin directories stay in the order they were registered", () => {
  const registry = new LocalRegistry();

  registry.registerPluginDirectory("/opt/plugins");
  registry.registerPluginDirectory("~/.xcl/plugins");

  assert.deepEqual(registry.toProto(), {
    kind: {
      case: "local",
      value: {
        pluginPattern: "",
        types: [],
          functions: [],
        externalPluginCommands: [],
        pluginDirectories: ["/opt/plugins", "~/.xcl/plugins"],
      },
    },
  });
});

test("the plugin pattern is carried", () => {
  const registry = new LocalRegistry({ pluginPattern: "xcl-plugin-*" });

  assert.deepEqual(registry.toProto(), {
    kind: {
      case: "local",
      value: {
        pluginPattern: "xcl-plugin-*",
        types: [],
          functions: [],
        externalPluginCommands: [],
        pluginDirectories: [],
      },
    },
  });
});

test("an empty GitHub registry has no plugins and empty settings", () => {
  const registry = new GitHubRegistry();

  assert.deepEqual(registry.toProto(), {
    kind: {
      case: "github",
      value: {
        plugins: [],
        types: [],
        cacheDir: "",
        trustedKeys: [],
        token: "",
        apiUrl: "",
      },
    },
  });
});

test("GitHub plugins stay in the order they were registered", () => {
  const registry = new GitHubRegistry();

  registry.registerPlugin("jumppad-labs/plugin-docker", "v1.2.3");
  registry.registerPlugin("jumppad-labs/plugin-aws", "v0.4.0");

  assert.deepEqual(registry.toProto(), {
    kind: {
      case: "github",
      value: {
        plugins: [
          { repository: "jumppad-labs/plugin-docker", version: "v1.2.3" },
          { repository: "jumppad-labs/plugin-aws", version: "v0.4.0" },
        ],
        types: [],
        cacheDir: "",
        trustedKeys: [],
        token: "",
        apiUrl: "",
      },
    },
  });
});

test("trusted keys stay in the order they were given", () => {
  const registry = new GitHubRegistry({ trustedKeys: ["first key", "second key"] });

  assert.deepEqual(registry.toProto(), {
    kind: {
      case: "github",
      value: {
        plugins: [],
        types: [],
        cacheDir: "",
        trustedKeys: ["first key", "second key"],
        token: "",
        apiUrl: "",
      },
    },
  });
});

test("the cache directory is carried", () => {
  const registry = new GitHubRegistry({ cacheDir: "/var/cache/xcl" });

  assert.deepEqual(registry.toProto(), {
    kind: {
      case: "github",
      value: {
        plugins: [],
        types: [],
        cacheDir: "/var/cache/xcl",
        trustedKeys: [],
        token: "",
        apiUrl: "",
      },
    },
  });
});

test("the token is carried", () => {
  const registry = new GitHubRegistry({ token: "a-token" });

  assert.deepEqual(registry.toProto(), {
    kind: {
      case: "github",
      value: {
        plugins: [],
        types: [],
        cacheDir: "",
        trustedKeys: [],
        token: "a-token",
        apiUrl: "",
      },
    },
  });
});

test("the API URL is carried", () => {
  const registry = new GitHubRegistry({ apiUrl: "https://github.example.com/api/v3" });

  assert.deepEqual(registry.toProto(), {
    kind: {
      case: "github",
      value: {
        plugins: [],
        types: [],
        cacheDir: "",
        trustedKeys: [],
        token: "",
        apiUrl: "https://github.example.com/api/v3",
      },
    },
  });
});

test("every GitHub option and plugin is carried together", () => {
  const registry = new GitHubRegistry({
    trustedKeys: ["a key"],
    cacheDir: "/var/cache/xcl",
    token: "a-token",
    apiUrl: "https://github.example.com/api/v3",
  });

  registry.registerPlugin("jumppad-labs/plugin-docker", "v1.2.3");

  assert.deepEqual(registry.toProto(), {
    kind: {
      case: "github",
      value: {
        plugins: [{ repository: "jumppad-labs/plugin-docker", version: "v1.2.3" }],
        types: [],
        cacheDir: "/var/cache/xcl",
        trustedKeys: ["a key"],
        token: "a-token",
        apiUrl: "https://github.example.com/api/v3",
      },
    },
  });
});

test("a GitHub plugin with no repository throws SchemaError", () => {
  const registry = new GitHubRegistry();

  assert.throws(() => registry.registerPlugin("", "v1.2.3"), SchemaError);
});

test("a GitHub plugin with no version throws SchemaError", () => {
  const registry = new GitHubRegistry();

  assert.throws(() => registry.registerPlugin("jumppad-labs/plugin-docker", ""), SchemaError);
});
