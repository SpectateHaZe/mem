import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId, type MemWatchedThread } from "@t3tools/contracts";
import { CircleAlertIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useQuietThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";

import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { InlineButton } from "../ui/button";
import { memWatchedThreadsAtom } from "./memOverseer";

const SHOWN = 3;

/** An escalation older than this is stale enough that the owner has moved on. */
export const RECENT_ESCALATION_MS = 12 * 60 * 60_000;

/** A queue entry, not just the thread: a second escalation has to be able to appear again. */
const escalationKey = (thread: MemWatchedThread) => `${thread.threadId}:${thread.updatedAtMs}`;

/** Threads Mem gave up on recently, newest rejection count first, capped for the banner. */
export const recentEscalations = (
  threads: ReadonlyArray<MemWatchedThread>,
  nowMs: number,
  dismissed: ReadonlyArray<string> = [],
): ReadonlyArray<MemWatchedThread> =>
  threads
    .filter((thread) => thread.phase === "escalated")
    // A record written before the timestamp existed has 0; showing it beats hiding a real stop.
    .filter(
      (thread) => thread.updatedAtMs === 0 || nowMs - thread.updatedAtMs <= RECENT_ESCALATION_MS,
    )
    .filter((thread) => !dismissed.includes(escalationKey(thread)))
    .toSorted((left, right) => right.rejections - left.rejections)
    .slice(0, SHOWN);

function EscalatedRow(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: MemWatchedThread;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const shell = useQuietThreadShell(
    scopeThreadRef(props.environmentId, ThreadId.make(props.thread.threadId)),
  );
  return (
    <li className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{shell?.title.trim() || "A thread"}</p>
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {props.thread.rejections === 1
            ? "Mem sent this back once and stopped."
            : `Mem sent this back ${props.thread.rejections} times and stopped.`}
        </p>
      </div>
      <InlineButton
        tone="muted"
        onClick={() => props.onOpenThread(ThreadId.make(props.thread.threadId))}
      >
        Open
      </InlineButton>
    </li>
  );
}

/**
 * Mem's chat names the sessions Mem stopped working on, because they are the ones waiting on the
 * owner to decide what "done" means.
 */
export function useMemEscalationsBanner(input: {
  readonly environmentId: EnvironmentId;
  readonly isMemThread: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}): ComposerBannerStackItem | null {
  const query = useEnvironmentQuery(
    memWatchedThreadsAtom(input.isMemThread ? input.environmentId : null),
  );
  const nowIso = useNowMinute();
  const [dismissed, setDismissed] = useState<ReadonlyArray<string>>([]);
  const escalated = recentEscalations(
    query.data?.threads ?? [],
    new Date(nowIso).getTime(),
    dismissed,
  );
  if (!input.isMemThread || escalated.length === 0) return null;
  return {
    id: "mem-escalations",
    variant: "warning",
    icon: <CircleAlertIcon />,
    title: `Mem stopped on ${escalated.length} session${escalated.length === 1 ? "" : "s"}`,
    description: "Rework did not land, so the next move is yours.",
    children: (
      <ul className="mt-1 space-y-1.5">
        {escalated.map((thread) => (
          <EscalatedRow
            key={thread.threadId}
            environmentId={input.environmentId}
            thread={thread}
            onOpenThread={input.onOpenThread}
          />
        ))}
      </ul>
    ),
    dismissLabel: "Dismiss",
    onDismiss: () => setDismissed((current) => [...current, ...escalated.map(escalationKey)]),
  };
}
