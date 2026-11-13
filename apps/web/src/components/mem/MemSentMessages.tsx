import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId, type MemWatchedThread } from "@t3tools/contracts";
import { SendIcon } from "lucide-react";
import { useState } from "react";

import { useQuietThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { InlineButton } from "../ui/button";
import { memWatchedThreadsAtom } from "./memOverseer";

const SHOWN = 3;

type SentMessage = MemWatchedThread & {
  readonly sentInstruction: string;
  readonly sentAtMs: number;
};

/** The newest messages Mem posted after `afterMs`, newest first. */
export function recentSentMessages(
  threads: ReadonlyArray<MemWatchedThread>,
  afterMs: number,
): ReadonlyArray<SentMessage> {
  return threads
    .filter(
      (thread): thread is SentMessage =>
        thread.sentInstruction !== null && thread.sentAtMs !== null && thread.sentAtMs > afterMs,
    )
    .toSorted((left, right) => right.sentAtMs - left.sentAtMs)
    .slice(0, SHOWN);
}

function SentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly sent: SentMessage;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const threadId = ThreadId.make(props.sent.threadId);
  const shell = useQuietThreadShell(scopeThreadRef(props.environmentId, threadId));
  return (
    <li className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">
          {shell?.title.trim() || "A thread"}
          <span className="ms-1.5 font-normal text-muted-foreground">
            {formatRelativeTimeLabel(new Date(props.sent.sentAtMs).toISOString())}
          </span>
        </p>
        <p className="line-clamp-2 text-xs text-muted-foreground">{props.sent.sentInstruction}</p>
      </div>
      <InlineButton tone="muted" onClick={() => props.onOpenThread(threadId)}>
        Open
      </InlineButton>
    </li>
  );
}

/** Mem's chat lists what she last posted in other threads, without spending a turn to say so. */
export function useMemSentMessagesBanner(input: {
  readonly environmentId: EnvironmentId;
  readonly isMemThread: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}): ComposerBannerStackItem | null {
  const query = useEnvironmentQuery(
    memWatchedThreadsAtom(input.isMemThread ? input.environmentId : null),
  );
  // Dismissing hides what was shown; anything Mem sends afterwards brings the card back.
  const [dismissedAtMs, setDismissedAtMs] = useState(0);
  const sent = recentSentMessages(query.data?.threads ?? [], dismissedAtMs);
  if (!input.isMemThread || sent.length === 0) return null;
  return {
    id: "mem-sent-messages",
    variant: "info",
    icon: <SendIcon />,
    title: "What Mem said in other threads",
    children: (
      <ul className="mt-1 space-y-1.5">
        {sent.map((message) => (
          <SentRow
            key={message.threadId}
            environmentId={input.environmentId}
            sent={message}
            onOpenThread={input.onOpenThread}
          />
        ))}
      </ul>
    ),
    dismissLabel: "Hide",
    onDismiss: () => setDismissedAtMs(sent[0]?.sentAtMs ?? Date.now()),
  };
}
