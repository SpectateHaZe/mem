import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId, type MemPendingApproval } from "@t3tools/contracts";
import { ShieldAlertIcon } from "lucide-react";
import { useState } from "react";

import { useQuietThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";

import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { InlineButton } from "../ui/button";
import { memPendingApprovalsAtom } from "./memOverseer";
import { useAnswerMemApproval } from "./useAnswerMemApproval";

const SHOWN = 3;

function ApprovalRow(props: {
  readonly environmentId: EnvironmentId;
  readonly approval: MemPendingApproval;
  readonly busy: boolean;
  readonly onDecide: (approval: MemPendingApproval, decision: "approve" | "deny") => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const shell = useQuietThreadShell(
    scopeThreadRef(props.environmentId, ThreadId.make(props.approval.threadId)),
  );
  return (
    <li className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{shell?.title.trim() || "A thread"}</p>
        <p className="line-clamp-2 font-mono text-xs text-muted-foreground">
          {props.approval.instruction}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <InlineButton
          disabled={props.busy}
          onClick={() => props.onDecide(props.approval, "approve")}
        >
          Approve
        </InlineButton>
        <InlineButton
          disabled={props.busy}
          onClick={() => props.onDecide(props.approval, "deny")}
          tone="muted"
        >
          Deny
        </InlineButton>
        <InlineButton
          tone="muted"
          onClick={() => props.onOpenThread(ThreadId.make(props.approval.threadId))}
        >
          Open
        </InlineButton>
      </div>
    </li>
  );
}

/**
 * Mem's chat says when an instruction is held for the owner, because that is the one thing Mem
 * will never decide alone. The queue also lives in Settings, for when Mem's chat is closed.
 */
export function useMemApprovalBanner(input: {
  readonly environmentId: EnvironmentId;
  readonly isMemThread: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}): ComposerBannerStackItem | null {
  const query = useEnvironmentQuery(
    memPendingApprovalsAtom(input.isMemThread ? input.environmentId : null),
  );
  const { busyApprovalId, error, decide } = useAnswerMemApproval(input.environmentId);
  const [answered, setAnswered] = useState<ReadonlyArray<string>>([]);
  const approvals = (query.data?.approvals ?? [])
    .filter((approval) => !answered.includes(approval.approvalId))
    .slice(0, SHOWN);
  if (!input.isMemThread || approvals.length === 0) return null;
  return {
    id: "mem-pending-approvals",
    variant: "warning",
    icon: <ShieldAlertIcon />,
    title: `Mem is waiting for you on ${approvals.length} session${approvals.length === 1 ? "" : "s"}`,
    description: "Mem will not send a destructive deletion on its own.",
    children: (
      <ul className="mt-1 space-y-1.5">
        {approvals.map((approval) => (
          <ApprovalRow
            key={approval.approvalId}
            approval={approval}
            busy={busyApprovalId === approval.approvalId}
            environmentId={input.environmentId}
            onOpenThread={input.onOpenThread}
            onDecide={(target, decision) => {
              void decide(target, decision).then(() => {
                setAnswered((current) => [...current, target.approvalId]);
                query.refresh();
              });
            }}
          />
        ))}
      </ul>
    ),
    ...(error === null ? {} : { description: error }),
  };
}
