import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

type LimitShell = Pick<
  EnvironmentThreadShell,
  "latestRun" | "runtime" | "limitRecovery" | "archivedAt"
>;

/** Threads stopped by a usage limit that limit recovery will resume on its own. */
const pausedResets = (threads: ReadonlyArray<LimitShell>, nowMs: number): number[] =>
  threads.flatMap((thread) => {
    const recovery = thread.limitRecovery;
    const run = thread.latestRun;
    if (
      thread.archivedAt !== null ||
      run === null ||
      run.status !== "failed" ||
      thread.runtime?.lastErrorClass !== "usage_limit" ||
      recovery == null ||
      !recovery.autoResume ||
      recovery.runId !== run.runId
    ) {
      return [];
    }
    const resetMs = Date.parse(recovery.resetAt);
    return Number.isFinite(resetMs) && resetMs > nowMs ? [resetMs] : [];
  });

/** "Paused until 04:00 (usage limit), resumes automatically" for the Mem card, or null. */
export function describeLimitPause(
  threads: ReadonlyArray<LimitShell>,
  nowMs: number,
  timeLabel: (ms: number) => string,
): string | null {
  const resets = pausedResets(threads, nowMs);
  if (resets.length === 0) return null;
  const count = resets.length === 1 ? "" : ` (${resets.length} sessions)`;
  return `Paused until ${timeLabel(Math.min(...resets))} (usage limit)${count}, resumes automatically`;
}
