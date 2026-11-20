import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationOperateScope,
  ThreadId,
  type EnvironmentId,
  type MemPendingApproval,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useQuietThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { buildThreadRouteParams } from "~/threadRoutes";

import { Button } from "../ui/button";
import { memPendingApprovalsAtom } from "./memOverseer";
import { useAnswerMemApproval } from "./useAnswerMemApproval";

/** A destructive instruction never expires, so an old one is still waiting, not stale. */
export const describeWaited = (createdAtMs: number, nowMs: number): string => {
  const minutes = Math.max(0, Math.floor((nowMs - createdAtMs) / 60_000));
  if (minutes < 1) return "waiting a moment";
  if (minutes < 60) return `waiting ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `waiting ${hours}h`;
  return `waiting ${Math.floor(hours / 24)}d`;
};

function MemApprovalRow(props: {
  readonly environmentId: EnvironmentId;
  readonly approval: MemPendingApproval;
  readonly busy: boolean;
  readonly onDecide: (approval: MemPendingApproval, decision: "approve" | "deny") => void;
}) {
  const { approval } = props;
  const navigate = useNavigate();
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const shell = useQuietThreadShell(
    scopeThreadRef(props.environmentId, ThreadId.make(approval.threadId)),
  );
  const nowIso = useNowMinute();
  // Mem refuses to steer a turn that is already running, so offering Approve there only fails.
  const running = threadRuntimeIsActive(shell?.runtime);

  const openSession = () => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(props.environmentId, ThreadId.make(approval.threadId)),
      ),
    });
  };

  return (
    <div className="space-y-2 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate text-sm font-medium">{shell?.title ?? approval.threadId}</span>
        <span className="text-muted-foreground text-xs">
          {describeWaited(approval.createdAtMs, new Date(nowIso).getTime())}
        </span>
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
        {approval.instruction}
      </pre>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!canOperate || props.busy || running}
          onClick={() => props.onDecide(approval, "approve")}
          size="compact"
          title={running ? "Wait until this session's turn ends." : undefined}
        >
          Approve
        </Button>
        <Button
          disabled={!canOperate || props.busy}
          onClick={() => props.onDecide(approval, "deny")}
          size="compact"
          variant="outline"
        >
          Deny
        </Button>
        <Button onClick={openSession} size="compact" variant="ghost">
          Open session
        </Button>
      </div>
      {running ? (
        <p className="text-muted-foreground text-xs">
          This session is mid-turn; approving now would be refused. Deny or wait for it to finish.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Every instruction Mem is holding until a human answers. A destructive deletion never auto-sends,
 * so without this list that block is invisible unless the owner opens that thread's mascot.
 */
export function MemApprovalQueue({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const atom = memPendingApprovalsAtom(environmentId);
  const { data, isPending, error, refresh } = useEnvironmentQuery(atom);
  if (environmentId === null) {
    return (
      <p className="px-3 py-3 text-muted-foreground text-sm sm:px-4">
        Connect a machine to see what Mem is waiting on.
      </p>
    );
  }
  if (error !== null) {
    return (
      <p className="text-destructive px-3 py-3 text-sm sm:px-4" role="alert">
        {error}
      </p>
    );
  }
  if (data === null) {
    return (
      <p className="px-3 py-3 text-muted-foreground text-sm sm:px-4">
        {isPending ? "Checking what Mem is waiting on." : "Could not read what Mem is waiting on."}
      </p>
    );
  }
  if (data.approvals.length === 0) {
    return (
      <p className="px-3 py-3 text-muted-foreground text-sm sm:px-4">
        Nothing is waiting for you. Mem only stops for a deletion it thinks is destructive.
      </p>
    );
  }
  return (
    <MemApprovalList
      environmentId={environmentId}
      approvals={data.approvals}
      onAnswered={refresh}
    />
  );
}

function MemApprovalList(props: {
  readonly environmentId: EnvironmentId;
  readonly approvals: ReadonlyArray<MemPendingApproval>;
  readonly onAnswered: () => void;
}) {
  const { busyApprovalId, error, decide } = useAnswerMemApproval(props.environmentId);
  return (
    <div className="divide-y">
      {props.approvals.map((approval) => (
        <MemApprovalRow
          key={approval.approvalId}
          approval={approval}
          busy={busyApprovalId === approval.approvalId}
          environmentId={props.environmentId}
          onDecide={(target, decision) => {
            void decide(target, decision).then(props.onAnswered);
          }}
        />
      ))}
      {error === null ? null : (
        <p className="text-destructive px-3 py-2 text-xs sm:px-4" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
