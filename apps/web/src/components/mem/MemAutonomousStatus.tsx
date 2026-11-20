import type { EnvironmentId, MemWatchedThread } from "@t3tools/contracts";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";

import { memPendingApprovalsAtom, memWatchedThreadsAtom } from "./memOverseer";

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
        : thread.waitingFor === "usage"
          ? `One session waits for its usage limit until ${timeLabel(thread.waitingUntilMs!)}.`
          : // A failed round, a reviewer that did not answer, or no review model: not a limit.
            `One session is paused until ${timeLabel(thread.waitingUntilMs!)}.`,
    ),
    rounds > 0 ? `${rounds} round${rounds === 1 ? "" : "s"} committed recently.` : null,
    latest === undefined ? null : `Latest: ${latest}`,
  ];
  return parts.filter((part) => part !== null).join(" ");
};

/** The same state in one short line, for the sidebar card where a sentence would truncate. */
export const describeAutonomyBrief = (threads: ReadonlyArray<MemWatchedThread>, nowMs: number) => {
  const active = threads.filter(
    (thread) => thread.phase === "claimed" || thread.phase === "awaitingReview",
  );
  if (active.length === 0) return "mark a session in progress";
  const waiting = active.filter(
    (thread) => thread.waitingUntilMs !== null && thread.waitingUntilMs > nowMs,
  );
  const working = active.length - waiting.length;
  if (working > 0) return `working on ${working} session${working === 1 ? "" : "s"}`;
  const until = Math.min(...waiting.map((thread) => thread.waitingUntilMs!));
  return `waiting until ${timeLabel(until)}`;
};

/**
 * Mem's card sub-line. With autonomous mode on it says what Mem is doing right now, so the owner
 * does not have to open Mem's chat to find out; otherwise it keeps the line the card always had.
 * A queued instruction wins the line: it is the only thing Mem cannot decide alone.
 */
export function MemCardStatusLine(props: {
  readonly environmentId: EnvironmentId;
  readonly fallback: string;
}) {
  const mem = useEnvironment(props.environmentId)?.serverConfig?.settings.mem;
  const { data } = useEnvironmentQuery(memWatchedThreadsAtom(props.environmentId));
  const { data: approvals } = useEnvironmentQuery(memPendingApprovalsAtom(props.environmentId));
  const nowIso = useNowMinute();
  if (mem?.autonomous !== true || data === null) return <>{props.fallback}</>;
  const waiting = approvals?.approvals.length ?? 0;
  if (waiting > 0) return <>{`${waiting} approval${waiting === 1 ? "" : "s"} waiting`}</>;
  return <>{describeAutonomyBrief(data.threads, new Date(nowIso).getTime())}</>;
}

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
