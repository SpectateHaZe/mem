import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  readClaudeSettingsSnapshot,
  resolveClaudeSettingsScopePaths,
  writeClaudeSettingsScope,
} from "./ClaudeSettingsFiles.ts";

const makeWorkspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectory({ prefix: "mem-claude-settings-" });
  const config = path.join(root, ".claude");
  const cwd = path.join(root, "repo");
  yield* fileSystem.makeDirectory(config, { recursive: true });
  yield* fileSystem.makeDirectory(cwd, { recursive: true });
  return { root, config, cwd };
});

it.layer(NodeServices.layer)("ClaudeSettingsFiles", (it) => {
  describe("scope resolution", () => {
    it.effect("lists user, project and local settings before managed settings", () =>
      Effect.gen(function* () {
        const workspace = yield* makeWorkspace;
        const path = yield* Path.Path;
        const scopes = yield* resolveClaudeSettingsScopePaths(
          { homePath: workspace.config },
          workspace.cwd,
        );

        expect(scopes.map((scope) => scope.scope)).toStrictEqual([
          "user",
          "project",
          "local",
          "managed",
        ]);
        expect(scopes[0]?.filePath).toBe(path.join(workspace.config, "settings.json"));
        expect(scopes[1]?.filePath).toBe(path.join(workspace.cwd, ".claude", "settings.json"));
        expect(scopes[2]?.filePath).toBe(
          path.join(workspace.cwd, ".claude", "settings.local.json"),
        );
        expect(scopes[3]?.writable).toBe(false);
      }),
    );
  });

  describe("reading", () => {
    it.effect("merges scopes and reports which file won each key", () =>
      Effect.gen(function* () {
        const workspace = yield* makeWorkspace;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* fileSystem.makeDirectory(path.join(workspace.cwd, ".claude"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(workspace.config, "settings.json"),
          `{
            // hand-edited
            "autoUpdatesChannel": "stable",
            "switchModelsOnFlag": true,
          }`,
        );
        yield* fileSystem.writeFileString(
          path.join(workspace.cwd, ".claude", "settings.json"),
          `{ "autoUpdatesChannel": "latest", }`,
        );

        const snapshot = yield* readClaudeSettingsSnapshot(
          { homePath: workspace.config },
          workspace.cwd,
        );

        expect(snapshot.merged.autoUpdatesChannel).toBe("latest");
        expect(snapshot.merged.switchModelsOnFlag).toBe(true);
        expect(snapshot.provenance.autoUpdatesChannel).toBe("project");
        expect(snapshot.provenance.switchModelsOnFlag).toBe("user");
        expect(snapshot.scopes.find((scope) => scope.scope === "local")?.exists).toBe(false);
      }),
    );

    it.effect("reports an unparsable file without failing the whole read", () =>
      Effect.gen(function* () {
        const workspace = yield* makeWorkspace;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* fileSystem.makeDirectory(workspace.config, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(workspace.config, "settings.json"),
          "[1, 2, 3]",
        );

        const snapshot = yield* readClaudeSettingsSnapshot(
          { homePath: workspace.config },
          workspace.cwd,
        );
        const user = snapshot.scopes.find((scope) => scope.scope === "user");

        expect(user?.value).toBeNull();
        expect(user?.error).not.toBeNull();
        expect(snapshot.merged).toStrictEqual({});
      }),
    );
  });

  describe("writing", () => {
    it.effect("writes pretty JSON, creates the directory and keeps the previous file", () =>
      Effect.gen(function* () {
        const workspace = yield* makeWorkspace;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userSettings = path.join(workspace.config, "settings.json");

        yield* writeClaudeSettingsScope({
          config: { homePath: workspace.config },
          cwd: workspace.cwd,
          scope: "user",
          contents: `{"modelSettings":{"claude-opus-5-5":{"autoCompactWindow":400000}}}`,
        });
        expect(yield* fileSystem.readFileString(userSettings)).toBe(
          `{\n  "modelSettings": {\n    "claude-opus-5-5": {\n      "autoCompactWindow": 400000\n    }\n  }\n}\n`,
        );

        yield* writeClaudeSettingsScope({
          config: { homePath: workspace.config },
          cwd: workspace.cwd,
          scope: "user",
          contents: `{"switchModelsOnFlag":false}`,
        });

        const backup = yield* fileSystem.readFileString(`${userSettings}.mem-backup`);
        const written = yield* fileSystem.readFileString(userSettings);
        expect(backup).toContain("autoCompactWindow");
        expect(written).toBe(`{\n  "switchModelsOnFlag": false\n}\n`);
      }),
    );

    it.effect("refuses managed settings and non-object payloads", () =>
      Effect.gen(function* () {
        const workspace = yield* makeWorkspace;

        const managed = yield* Effect.exit(
          writeClaudeSettingsScope({
            config: { homePath: workspace.config },
            cwd: workspace.cwd,
            scope: "managed",
            contents: `{"autoUpdatesChannel":"latest"}`,
          }),
        );
        expect(managed._tag).toBe("Failure");

        const invalid = yield* Effect.exit(
          writeClaudeSettingsScope({
            config: { homePath: workspace.config },
            cwd: workspace.cwd,
            scope: "user",
            contents: `["not", "an", "object"]`,
          }),
        );
        expect(invalid._tag).toBe("Failure");
      }),
    );
  });
});
