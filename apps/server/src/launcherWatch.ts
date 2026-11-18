import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

const DEFAULT_POLL_INTERVAL = Duration.seconds(2);

// Capture before config and bootstrap reads to detect launcher loss during startup.
const startupParentPid = process.ppid;

/**
 * Any parent change signals launcher loss, including adoption by a Linux subreaper;
 * otherwise an orphan backend keeps its ownership lock and blocks replacement launches.
 * Windows keeps reporting the exited parent's id, so there the launcher's own process is
 * checked instead. Skip init-launched backends.
 */
export const awaitLauncherLoss = Effect.fn("launcherWatch.awaitLauncherLoss")(function* (options?: {
  readonly launcherPid?: number;
  readonly getParentPid?: () => number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly interval?: Duration.Input;
}): Effect.fn.Return<void> {
  const platform = yield* HostProcess.Platform;
  const launcherPid = options?.launcherPid ?? startupParentPid;
  const getParentPid = options?.getParentPid ?? (() => process.ppid);
  const interval = options?.interval ?? DEFAULT_POLL_INTERVAL;
  const isProcessAlive = options?.isProcessAlive ?? processExists;
  if (launcherPid <= 1) return yield* Effect.never;
  const poll: Effect.Effect<void> = Effect.suspend(() => {
    // shortcut: a reused pid reads as alive, which only delays the shutdown, never forces one.
    const parentPid =
      platform === "win32" ? (isProcessAlive(launcherPid) ? launcherPid : 0) : getParentPid();
    return parentPid === launcherPid
      ? Effect.flatMap(Effect.sleep(interval), () => poll)
      : Effect.logWarning("desktop launcher is gone; shutting down the backend", {
          launcherPid,
          parentPid,
        });
  });
  return yield* poll;
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
