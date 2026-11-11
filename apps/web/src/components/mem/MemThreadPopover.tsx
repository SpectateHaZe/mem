import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadLifecycle } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PopoverTitle } from "../ui/popover";
import { memAnswerApproval, memSetLifecycle } from "./memOverseer";
import { memThreadSeed } from "./memThreadPrompt";
import { useMemThreadData } from "./useMemThreadData";

const failureMessage = (failure: unknown, fallback: string) =>
  failure instanceof Error && failure.message.trim().length > 0 ? failure.message : fallback;

/**
 * What Mem thinks of this thread, and the two controls the owner needs to steer it: the lifecycle
 * mark that lets Mem watch it, and an unsent opener in Mem's own session.
 */
export function MemThreadPopover(props: {
  readonly threadRef: ScopedThreadRef;
  readonly title: string | null;
  readonly lifecycle: ThreadLifecycle;
  readonly onClose: () => void;
}) {
  const { threadRef } = props;
  const navigate = useNavigate();
  const { state, pendingApproval, isLoading, refresh } = useMemThreadData(threadRef);
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const setLifecycle = useAtomCommand(memSetLifecycle, { reportFailure: false });
  const answer = useAtomCommand(memAnswerApproval, { reportFailure: false });
  const [busy, setBusy] = useState<"lifecycle" | "approval" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const watching = props.lifecycle === "in_progress";

  const mark = async (lifecycle: ThreadLifecycle) => {
    if (busy !== null || !canOperate) return;
    setBusy("lifecycle");
    setError(null);
    const result = await setLifecycle({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, lifecycle },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(
        failureMessage(squashAtomCommandFailure(result), "Could not update the thread's status."),
      );
    } else if (result._tag === "Success") {
      refresh();
    }
    setBusy(null);
  };

  const answerPendingApproval = async (decision: "approve" | "deny") => {
    if (busy !== null || pendingApproval === null) return;
    setBusy("approval");
    setError(null);
    const result = await answer({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        approvalId: pendingApproval.approvalId,
        decision,
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(failureMessage(squashAtomCommandFailure(result), "Could not answer Mem."));
    } else if (result._tag === "Success" && result.value.outcome === "failed") {
      setError("Mem could not send that answer. Try again.");
    }
    refresh();
    setBusy(null);
  };

  const askMem = () => {
    const masterThreadId = state.masterThreadId?.trim();
    if (masterThreadId === undefined || masterThreadId.length === 0) return;
    const target = scopeThreadRef(threadRef.environmentId, ThreadId.make(masterThreadId));
    const seed = memThreadSeed(props.title, threadRef.threadId);
    const drafts = useComposerDraftStore.getState();
    const existing = drafts.getComposerDraft(target)?.prompt ?? "";
    drafts.setPrompt(
      target,
      existing.trim().length === 0 ? seed : `${existing.trimEnd()}\n\n${seed}`,
    );
    props.onClose();
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <PopoverTitle>Mem</PopoverTitle>
        <Badge size="sm" variant={watching ? "info" : "outline"}>
          {watching ? "Watching" : "Not watching"}
        </Badge>
      </div>

      {state.verdict === null ? (
        <p className="text-muted-foreground text-xs">
          {isLoading
            ? "Checking what Mem thinks of this thread."
            : watching
              ? "Mem is watching this thread but has not reviewed it yet."
              : "Mem has not reviewed this thread."}
        </p>
      ) : (
        <div className="space-y-1.5 rounded-md border p-2">
          <Badge size="sm" variant={state.verdict === "accept" ? "success" : "warning"}>
            {state.verdict === "accept" ? "Accepted" : "Sent back"}
          </Badge>
          {state.reason === null ? null : (
            <p className="text-muted-foreground text-xs">{state.reason}</p>
          )}
        </div>
      )}

      {pendingApproval === null ? null : (
        <div className="space-y-1.5 rounded-md border p-2">
          <p className="text-xs font-medium">Mem needs an answer</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
            {pendingApproval.instruction}
          </pre>
          <div className="flex gap-2">
            <Button
              disabled={busy !== null}
              onClick={() => void answerPendingApproval("approve")}
              size="compact"
            >
              Approve
            </Button>
            <Button
              disabled={busy !== null}
              onClick={() => void answerPendingApproval("deny")}
              size="compact"
              variant="outline"
            >
              Deny
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!canOperate || busy !== null || watching}
          onClick={() => void mark("in_progress")}
          size="sm"
          variant="outline"
        >
          Mark in progress
        </Button>
        <Button
          disabled={!canOperate || busy !== null || props.lifecycle === "complete"}
          onClick={() => void mark("complete")}
          size="sm"
          variant="outline"
        >
          Mark complete
        </Button>
        <Button
          disabled={state.masterThreadId === null}
          onClick={askMem}
          size="sm"
          title={state.masterThreadId === null ? "Mem's session is not set up yet." : undefined}
        >
          Ask Mem
        </Button>
      </div>

      {error === null ? null : (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
