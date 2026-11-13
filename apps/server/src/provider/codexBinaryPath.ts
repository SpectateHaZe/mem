import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

export interface CodexDesktopCliVersionDirectory {
  readonly name: string;
  readonly modifiedAtMs: number;
}

/** The desktop app's hash directory changes on every update, so newest wins. */
export function pickCodexDesktopCliVersionDirectory(
  entries: ReadonlyArray<CodexDesktopCliVersionDirectory>,
): string | null {
  let newest: CodexDesktopCliVersionDirectory | null = null;
  for (const entry of entries) {
    if (
      newest === null ||
      entry.modifiedAtMs > newest.modifiedAtMs ||
      (entry.modifiedAtMs === newest.modifiedAtMs && entry.name > newest.name)
    ) {
      newest = entry;
    }
  }
  return newest?.name ?? null;
}

// shortcut: The Codex desktop app is Windows-only for this fallback; macOS has no comparable
// documented install location in this repo, so do not invent one.
const findCodexDesktopCliExecutable = Effect.fn("findCodexDesktopCliExecutable")(function* (input: {
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const platform = yield* HostProcess.Platform;
  if (platform !== "win32") return null;
  const environment = input.environment ?? (yield* HostProcess.Environment);
  const localAppData = environment.LOCALAPPDATA;
  if (!localAppData) return null;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const binDirectory = path.join(localAppData, "OpenAI", "Codex", "bin");
  const names = yield* fs
    .readDirectory(binDirectory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const candidates: Array<CodexDesktopCliVersionDirectory> = [];
  for (const name of names) {
    const executable = path.join(binDirectory, name, "codex.exe");
    const info = yield* fs.stat(executable).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") continue;
    candidates.push({
      name,
      modifiedAtMs: Option.getOrUndefined(info.value.mtime)?.getTime() ?? 0,
    });
  }
  const newest = pickCodexDesktopCliVersionDirectory(candidates);
  return newest === null ? null : path.join(binDirectory, newest, "codex.exe");
});

// An npm global install can leave its cmd shim behind after the package folder is removed.
const isBrokenNpmCommandShim = Effect.fn("isBrokenNpmCommandShim")(function* (commandPath: string) {
  const platform = yield* HostProcess.Platform;
  const path = yield* Path.Path;
  if (platform !== "win32" || path.extname(commandPath).toLowerCase() !== ".cmd") return false;
  const fs = yield* FileSystem.FileSystem;
  const shim = yield* fs.readFileString(commandPath).pipe(Effect.option);
  if (Option.isNone(shim)) return false;
  const targets = Array.from(shim.value.matchAll(/"%dp0%\\([^"%]+)"/giu), (match) => match[1]!)
    .filter((target) => target.toLowerCase().includes("node_modules"))
    .map((target) => path.join(path.dirname(commandPath), target));
  if (targets.length === 0) return false;
  for (const target of targets) {
    if (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false))) return false;
  }
  return true;
});

/** Resolve the Codex executable the way a probe or a session should spawn it. */
export const resolveCodexBinaryPath = Effect.fn("resolveCodexBinaryPath")(function* (input: {
  readonly binaryPath: string;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const configured = input.binaryPath.trim();
  if (configured.length > 0 && configured !== "codex") return configured;
  const onPath = yield* resolveCommandPath(
    "codex",
    input.environment ? { env: input.environment } : {},
  ).pipe(Effect.orElseSucceed((): string | null => null));
  if (onPath !== null && !(yield* isBrokenNpmCommandShim(onPath))) return "codex";
  return (yield* findCodexDesktopCliExecutable(input)) ?? "codex";
});
