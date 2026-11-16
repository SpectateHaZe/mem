import type { EnvironmentId, MemWatchedThread } from "@t3tools/contracts";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useEnvironmentQuery } from "~/state/query";

import { memWatchedThreadsAtom } from "./memOverseer";

const timeLabel = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** One line on what autonomous mode is doing now, from the threads Mem tracks. */
export const describeAutonomy = (threads: ReadonlyArray<MemWatchedThread>, nowMs: number) => {
  // shortcut: a session unmarked by hand keeps its record, so it can still count here until pruned.
  const active = threads.filter(
    (thread) => thread.phase === "claimed" || thread.phase === "awaitingReview",
  );
  const waiting = active.filter(
    (thread) => thread.waitingUntilMs !== null && thread.waitingUntilMs > nowMs,
  );
  const rounds = active.reduce((sum, thread) => sum + thread.roundSummaries.length, 0);
  const latest = active.flatMap((thread) => thread.roundSummaries.slice(-1)).at(-1);
  if (active.length === 0) return "Mark a session In progress for Mem to start on it.";
  const working = active.length - waiting.length;
  const parts = [
    working > 0 ? `Working on ${working} session${working === 1 ? "" : "s"}.` : null,
    ...waiting.map((thread) =>
      thread.waitingFor === "budget"
        ? `One session waits for the spending cap until ${timeLabel(thread.waitingUntilMs!)}.`
        : `One session waits for its usage limit until ${timeLabel(thread.waitingUntilMs!)}.`,
    ),
    rounds > 0 ? `${rounds} round${rounds === 1 ? "" : "s"} committed recently.` : null,
    latest === undefined ? null : `Latest: ${latest}`,
  ];
  return parts.filter((part) => part !== null).join(" ");
};

export function MemAutonomousStatus({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const { data } = useEnvironmentQuery(memWatchedThreadsAtom(environmentId));
  const nowIso = useNowMinute();
  if (data === undefined || data === null) return null;
  return (
    <p className="text-muted-foreground text-xs" role="status">
      {describeAutonomy(data.threads, new Date(nowIso).getTime())}
    </p>
  );
}
