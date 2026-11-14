import {
  ClaudePluginsError,
  type ClaudeAvailablePlugin,
  type ClaudeInstalledPlugin,
  type ClaudeMarketplace,
  type ClaudePluginAction,
  type ClaudePluginsSnapshot,
  type ClaudeSettings,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { runClaudeCommand } from "../ClaudeProvider.ts";
import { resolveClaudeHomePath } from "./ClaudeHome.ts";
import { discoverClaudeSkills } from "./ClaudeSkills.ts";

/** Installs clone repositories, so give them far longer than a probe. */
const COMMAND_TIMEOUT = Duration.minutes(5);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const parseJson = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
};

export function parseInstalledPlugins(value: unknown): ReadonlyArray<ClaudeInstalledPlugin> {
  const list = Array.isArray(value) ? value : [];
  return list.flatMap((raw) => {
    const entry = record(raw);
    const id = text(entry.id);
    if (!id) return [];
    const version = text(entry.version);
    const lastUpdated = text(entry.lastUpdated);
    return [
      {
        id,
        scope: text(entry.scope) ?? "user",
        enabled: entry.enabled === true,
        ...(version ? { version } : {}),
        ...(lastUpdated ? { lastUpdated } : {}),
      },
    ];
  });
}

export function parseAvailablePlugins(value: unknown): ReadonlyArray<ClaudeAvailablePlugin> {
  const list = Array.isArray(value) ? value : [];
  return list.flatMap((raw) => {
    const entry = record(raw);
    const pluginId = text(entry.pluginId);
    const name = text(entry.name);
    if (!pluginId || !name) return [];
    const description = text(entry.description);
    return [
      {
        pluginId,
        name,
        marketplaceName: text(entry.marketplaceName) ?? "",
        ...(description ? { description } : {}),
        ...(typeof entry.installCount === "number" ? { installCount: entry.installCount } : {}),
      },
    ];
  });
}

export function parseMarketplaces(value: unknown): ReadonlyArray<ClaudeMarketplace> {
  const list = Array.isArray(value) ? value : [];
  return list.flatMap((raw) => {
    const entry = record(raw);
    const name = text(entry.name);
    if (!name) return [];
    return [
      {
        name,
        origin: text(entry.repo) ?? text(entry.url) ?? text(entry.path) ?? text(entry.source) ?? "",
      },
    ];
  });
}

/** The CLI's own message, without the noise of a stack trace. */
const failureDetail = (result: { stdout: string; stderr: string; code: number }): string => {
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("at "));
  return lines.slice(-4).join(" ") || `claude exited with code ${result.code}`;
};

const claude = (settings: ClaudeSettings, args: ReadonlyArray<string>) =>
  runClaudeCommand(settings, args).pipe(
    Effect.mapError(
      (error) =>
        new ClaudePluginsError({ detail: `Could not run the Claude CLI: ${error.message}` }),
    ),
    Effect.timeoutOrElse({
      duration: COMMAND_TIMEOUT,
      orElse: () =>
        Effect.fail(new ClaudePluginsError({ detail: "The Claude CLI took too long." })),
    }),
  );

const claudeOk = (settings: ClaudeSettings, args: ReadonlyArray<string>) =>
  claude(settings, args).pipe(
    Effect.filterOrFail(
      (result) => result.code === 0,
      (result) => new ClaudePluginsError({ detail: failureDetail(result) }),
    ),
  );

const skillsDirectory = Effect.fn("skillsDirectory")(function* (settings: ClaudeSettings) {
  const path = yield* Path.Path;
  return path.join(yield* resolveClaudeHomePath(settings, process.env), "skills");
});

const personalSkills = Effect.fn("personalSkills")(function* (
  settings: ClaudeSettings,
  directory: string,
) {
  const path = yield* Path.Path;
  const skills = yield* discoverClaudeSkills(settings);
  return skills.flatMap((skill) =>
    skill.scope === "user" && path.dirname(path.dirname(skill.path)) === directory
      ? [
          {
            name: skill.name,
            path: path.dirname(skill.path),
            ...(skill.description ? { description: skill.description } : {}),
          },
        ]
      : [],
  );
});

export const readClaudePlugins = Effect.fn("readClaudePlugins")(function* (
  settings: ClaudeSettings,
) {
  const directory = yield* skillsDirectory(settings);
  const skills = yield* personalSkills(settings, directory);
  const lists = yield* Effect.all(
    [
      claudeOk(settings, ["plugin", "list", "--json", "--available"]),
      claudeOk(settings, ["plugin", "marketplace", "list", "--json"]),
    ],
    { concurrency: 2 },
  ).pipe(Effect.result);
  if (lists._tag === "Failure") {
    return {
      installed: [],
      available: [],
      marketplaces: [],
      skills,
      skillsDirectory: directory,
      error: lists.failure.detail,
    } satisfies ClaudePluginsSnapshot;
  }
  const [plugins, marketplaces] = lists.success;
  const pluginJson = record(parseJson(plugins.stdout));
  return {
    installed: parseInstalledPlugins(pluginJson.installed),
    available: parseAvailablePlugins(pluginJson.available),
    marketplaces: parseMarketplaces(parseJson(marketplaces.stdout)),
    skills,
    skillsDirectory: directory,
    error: null,
  } satisfies ClaudePluginsSnapshot;
});

const PLUGIN_ARGS: Partial<Record<ClaudePluginAction, ReadonlyArray<string>>> = {
  install: ["plugin", "install"],
  uninstall: ["plugin", "uninstall"],
  update: ["plugin", "update"],
  enable: ["plugin", "enable"],
  disable: ["plugin", "disable"],
  marketplaceAdd: ["plugin", "marketplace", "add"],
  marketplaceRemove: ["plugin", "marketplace", "remove"],
  marketplaceUpdate: ["plugin", "marketplace", "update"],
};

/**
 * Runs one change and returns the fresh lists. Installs never pass `-y`, so a plugin that
 * installs by running a marketplace-declared command is refused instead of run unseen.
 */
export const runClaudePluginAction = Effect.fn("runClaudePluginAction")(function* (
  settings: ClaudeSettings,
  action: ClaudePluginAction,
  target: string,
) {
  // The target is passed to the CLI as an argument; a leading dash would read as a flag.
  if (target.startsWith("-")) {
    return yield* new ClaudePluginsError({ detail: `"${target}" is not a valid name.` });
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const args = PLUGIN_ARGS[action];
  if (args) {
    yield* claudeOk(settings, [...args, target]);
  } else if (action === "skillAdd") {
    const source = path.resolve(target);
    const hasSkill = yield* fileSystem
      .exists(path.join(source, "SKILL.md"))
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasSkill) {
      return yield* new ClaudePluginsError({
        detail: `${source} has no SKILL.md, so it is not a skill folder.`,
      });
    }
    const directory = yield* skillsDirectory(settings);
    const destination = path.join(directory, path.basename(source));
    if (yield* fileSystem.exists(destination).pipe(Effect.orElseSucceed(() => false))) {
      return yield* new ClaudePluginsError({
        detail: `A skill named ${path.basename(source)} already exists.`,
      });
    }
    yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(
      Effect.andThen(fileSystem.copy(source, destination)),
      Effect.mapError(
        (error) => new ClaudePluginsError({ detail: `Could not copy the skill: ${error.message}` }),
      ),
    );
  } else {
    const directory = yield* skillsDirectory(settings);
    const skill = (yield* personalSkills(settings, directory)).find((s) => s.name === target);
    // Only folders the listing found directly inside the skills folder can be removed.
    if (!skill || path.dirname(skill.path) !== directory) {
      return yield* new ClaudePluginsError({ detail: `No personal skill named ${target}.` });
    }
    yield* fileSystem
      .remove(skill.path, { recursive: true })
      .pipe(
        Effect.mapError(
          (error) =>
            new ClaudePluginsError({ detail: `Could not remove the skill: ${error.message}` }),
        ),
      );
  }
  return yield* readClaudePlugins(settings);
});
