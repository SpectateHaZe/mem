import {
  ClaudeSettings,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

import { resolveClaudeHomePath } from "./ClaudeHome.ts";

/** Ordered lowest precedence first, matching the order Claude Code merges them in. */
const CLAUDE_SETTINGS_SCOPES = ["user", "project", "local", "managed"] as const;

export type ClaudeSettingsScope = (typeof CLAUDE_SETTINGS_SCOPES)[number];

export interface ClaudeSettingsScopePath {
  readonly scope: ClaudeSettingsScope;
  readonly label: string;
  readonly filePath: string;
  /** Managed settings come from the machine's administrator and are never written from Mem. */
  readonly writable: boolean;
}

export interface ClaudeSettingsScopeFile extends ClaudeSettingsScopePath {
  readonly exists: boolean;
  readonly contents: string;
  readonly value: Record<string, unknown> | null;
  readonly error: string | null;
}

export interface ClaudeSettingsSnapshot {
  readonly scopes: ReadonlyArray<ClaudeSettingsScopeFile>;
  readonly merged: Record<string, unknown>;
  /** Winning scope for every top-level key in `merged`. */
  readonly provenance: Record<string, ClaudeSettingsScope>;
}

const SCOPES: ReadonlyArray<{
  readonly scope: ClaudeSettingsScope;
  readonly label: string;
  readonly writable: boolean;
}> = [
  { scope: "user", label: "User settings", writable: true },
  { scope: "project", label: "Project settings", writable: true },
  { scope: "local", label: "Project settings (local)", writable: true },
  { scope: "managed", label: "Managed settings (administrator)", writable: false },
];

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeLenientObject = Schema.decodeUnknownEffect(fromLenientJson(JsonObject));
const decodeSubmittedJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeSettingsConfig = Schema.decodeUnknownOption(ClaudeSettings);

/**
 * The settings editor edits the home the default enabled Claude instance runs with, so it shows
 * the same files a thread on that instance reads and writes.
 */
export const claudeSettingsConfigForInstances = (
  instances: ProviderInstanceConfigMap,
): Pick<ClaudeSettings, "homePath"> => ({
  homePath: claudeConfigForInstances(instances).homePath,
});

/** The whole config of that same instance, for running its Claude binary. */
export const claudeConfigForInstances = (instances: ProviderInstanceConfigMap): ClaudeSettings => {
  const claudeInstances = Object.entries(instances).filter(
    ([, instance]) => instance.driver === "claudeAgent",
  );
  const chosen =
    claudeInstances.find(
      ([instanceId, instance]) =>
        instanceId === "claudeAgent" && resolveProviderInstanceEnabled(instance),
    ) ??
    claudeInstances.find(([, instance]) => resolveProviderInstanceEnabled(instance)) ??
    claudeInstances[0];
  const config =
    chosen === undefined
      ? undefined
      : Option.getOrUndefined(decodeClaudeSettingsConfig(chosen[1].config ?? {}));
  return config ?? Option.getOrThrow(decodeClaudeSettingsConfig({}));
};

const managedSettingsPath = (
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | undefined => {
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (platform === "win32") {
    const programData = environment.PROGRAMDATA?.trim();
    return programData ? path.join(programData, "ClaudeCode", "managed-settings.json") : undefined;
  }
  return "/etc/claude-code/managed-settings.json";
};

export const resolveClaudeSettingsScopePaths = Effect.fn("resolveClaudeSettingsScopePaths")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    cwd: string,
  ): Effect.fn.Return<ReadonlyArray<ClaudeSettingsScopePath>, never, Path.Path> {
    const path = yield* Path.Path;
    const environment = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    const configDirectory = yield* resolveClaudeHomePath(config, environment);
    const managed = managedSettingsPath(path, platform, environment);

    const resolved: Record<ClaudeSettingsScope, string | undefined> = {
      user: path.join(configDirectory, "settings.json"),
      project: path.join(cwd, ".claude", "settings.json"),
      local: path.join(cwd, ".claude", "settings.local.json"),
      managed,
    };

    return SCOPES.flatMap((entry) => {
      const filePath = resolved[entry.scope];
      return filePath === undefined ? [] : [{ ...entry, filePath }];
    });
  },
);

const readScope = Effect.fnUntraced(function* (
  entry: ClaudeSettingsScopePath,
): Effect.fn.Return<ClaudeSettingsScopeFile, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const exists = yield* fileSystem.exists(entry.filePath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return { ...entry, exists: false, contents: "", value: null, error: null };
  }

  const contents = yield* fileSystem
    .readFileString(entry.filePath)
    .pipe(Effect.orElseSucceed(() => null));
  if (contents === null) {
    return {
      ...entry,
      exists: true,
      contents: "",
      value: null,
      error: "Could not read this file.",
    };
  }

  // Hand-edited settings files use comments and trailing commas, and Claude Code accepts them.
  const decoded = yield* decodeLenientObject(contents).pipe(
    Effect.map((value) => ({ value, error: null as string | null })),
    Effect.orElseSucceed(() => ({ value: null, error: "This file is not a JSON object." })),
  );

  return { ...entry, exists: true, contents, value: decoded.value, error: decoded.error };
});

export const readClaudeSettingsSnapshot = Effect.fn("readClaudeSettingsSnapshot")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd: string,
): Effect.fn.Return<ClaudeSettingsSnapshot, never, FileSystem.FileSystem | Path.Path> {
  const paths = yield* resolveClaudeSettingsScopePaths(config, cwd);
  const scopes = yield* Effect.forEach(paths, (entry) => readScope(entry));

  const merged: Record<string, unknown> = {};
  const provenance: Record<string, ClaudeSettingsScope> = {};
  for (const file of scopes) {
    if (file.value === null) continue;
    for (const [key, value] of Object.entries(file.value)) {
      merged[key] = value;
      provenance[key] = file.scope;
    }
  }

  return { scopes, merged, provenance };
});

export type ClaudeSettingsWriteError =
  | { readonly _tag: "ScopeNotWritable"; readonly scope: ClaudeSettingsScope }
  | { readonly _tag: "InvalidJson"; readonly message: string }
  | { readonly _tag: "WriteFailed"; readonly message: string };

const formatJson = (value: Record<string, unknown>) => `${JSON.stringify(value, null, 2)}\n`;

const parseSubmittedObject = (
  contents: string,
): Effect.Effect<Record<string, unknown>, ClaudeSettingsWriteError> =>
  decodeSubmittedJson(contents).pipe(
    Effect.mapError(() => ({
      _tag: "InvalidJson" as const,
      message: "Settings must be valid JSON.",
    })),
    Effect.filterOrFail(
      (value): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value),
      () => ({ _tag: "InvalidJson" as const, message: "Settings must be a JSON object." }),
    ),
  );

/** Overwrites one scope, keeping the previous contents beside it so a bad edit is one copy away. */
export const writeClaudeSettingsScope = Effect.fn("writeClaudeSettingsScope")(function* (input: {
  readonly config: Pick<ClaudeSettings, "homePath">;
  readonly cwd: string;
  readonly scope: ClaudeSettingsScope;
  readonly contents: string;
}): Effect.fn.Return<
  ClaudeSettingsScopeFile,
  ClaudeSettingsWriteError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* resolveClaudeSettingsScopePaths(input.config, input.cwd);
  const entry = paths.find((candidate) => candidate.scope === input.scope);
  if (entry === undefined || !entry.writable) {
    return yield* Effect.fail({ _tag: "ScopeNotWritable" as const, scope: input.scope });
  }

  const value = yield* parseSubmittedObject(input.contents);
  const previous = yield* fileSystem
    .readFileString(entry.filePath)
    .pipe(Effect.orElseSucceed(() => null));

  const writeSettings = (contents: string) =>
    fileSystem.makeDirectory(path.dirname(entry.filePath), { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFileString(entry.filePath, contents)),
      Effect.mapError((error) => ({ _tag: "WriteFailed" as const, message: String(error) })),
    );

  if (previous !== null && previous !== formatJson(value)) {
    yield* fileSystem
      .writeFileString(`${entry.filePath}.mem-backup`, previous)
      .pipe(Effect.orElseSucceed(() => undefined));
  }

  yield* writeSettings(formatJson(value));

  return {
    ...entry,
    exists: true,
    contents: formatJson(value),
    value,
    error: null,
  };
});
