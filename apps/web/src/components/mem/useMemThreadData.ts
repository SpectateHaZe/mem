import type { MemPendingApproval, MemThreadState, ScopedThreadRef } from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { memPendingApprovalsAtom, memThreadStateAtom, NO_MEM_THREAD_STATE } from "./memOverseer";

interface MemThreadData {
  readonly state: MemThreadState;
  readonly pendingApproval: MemPendingApproval | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
}

/** This thread's Mem state plus any approval Mem is waiting on for it. */
export function useMemThreadData(threadRef: ScopedThreadRef | null): MemThreadData {
  const stateQuery = useEnvironmentQuery(memThreadStateAtom(threadRef));
  const approvalsQuery = useEnvironmentQuery(
    memPendingApprovalsAtom(threadRef?.environmentId ?? null),
  );
  const pendingApproval =
    threadRef === null
      ? null
      : (approvalsQuery.data?.approvals.find(
          (approval) => approval.threadId === threadRef.threadId,
        ) ?? null);
  return {
    state: stateQuery.data ?? NO_MEM_THREAD_STATE,
    pendingApproval,
    isLoading: stateQuery.isPending || approvalsQuery.isPending,
    refresh: () => {
      stateQuery.refresh();
      approvalsQuery.refresh();
    },
  };
}
