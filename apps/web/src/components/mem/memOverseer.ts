import {
  WS_METHODS,
  type EnvironmentId,
  type MemThreadState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";

export const NO_MEM_THREAD_STATE: MemThreadState = {
  verdict: null,
  reason: null,
  masterThreadId: null,
};

const memThreadStateQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:mem-overseer:thread-state",
  tag: WS_METHODS.memOverseerThreadState,
  staleTimeMs: 15_000,
});

const memPendingApprovalsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:mem-overseer:pending-approvals",
  tag: WS_METHODS.memOverseerListApprovals,
  staleTimeMs: 15_000,
});

const memWatchedThreadsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:mem-overseer:watched",
  tag: WS_METHODS.memOverseerListWatched,
  staleTimeMs: 15_000,
});

export const memWatchedThreadsAtom = (environmentId: EnvironmentId | null) =>
  environmentId === null ? null : memWatchedThreadsQuery({ environmentId, input: {} });

export const memAnswerApproval = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:mem-overseer:answer-approval",
  tag: WS_METHODS.memOverseerAnswerApproval,
});

/** Marking through Mem re-opens its task, so the loop reviews the thread again. */
export const memSetLifecycle = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:mem-overseer:set-lifecycle",
  tag: WS_METHODS.memOverseerSetLifecycle,
});

export const memThreadStateAtom = (threadRef: ScopedThreadRef | null) =>
  threadRef === null
    ? null
    : memThreadStateQuery({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });

export const memPendingApprovalsAtom = (environmentId: EnvironmentId | null) =>
  environmentId === null ? null : memPendingApprovalsQuery({ environmentId, input: {} });
