import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, MemPendingApproval } from "@t3tools/contracts";
import { useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";

import { memAnswerApproval } from "./memOverseer";

const failureMessage = (failure: unknown, fallback: string) =>
  failure instanceof Error && failure.message.trim().length > 0 ? failure.message : fallback;

/** `still-waiting` means the answer was recorded but Mem could not send it, so it stays queued. */
export type MemApprovalOutcome = "answered" | "already-answered" | "still-waiting" | "error";

/**
 * Approve or deny one of Mem's queued instructions. Both the settings queue and the composer
 * banner answer through here, so an answered-without-sending outcome reads the same everywhere.
 */
export function useAnswerMemApproval(environmentId: EnvironmentId) {
  const answer = useAtomCommand(memAnswerApproval, { reportFailure: false });
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (
    approval: MemPendingApproval,
    decision: "approve" | "deny",
  ): Promise<MemApprovalOutcome> => {
    if (busyApprovalId !== null) return "still-waiting";
    setBusyApprovalId(approval.approvalId);
    setError(null);
    const result = await answer({
      environmentId,
      input: {
        threadId: approval.threadId,
        approvalId: approval.approvalId,
        decision,
      },
    });
    let outcome: MemApprovalOutcome = "answered";
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(failureMessage(squashAtomCommandFailure(result), "Could not answer Mem."));
      outcome = "error";
    } else if (result._tag === "Success" && result.value.outcome === "failed") {
      setError("Mem could not send that answer. Try again.");
      outcome = "still-waiting";
    } else if (result._tag === "Success" && result.value.outcome === "missing") {
      setError("That approval was already answered.");
      outcome = "already-answered";
    }
    setBusyApprovalId(null);
    return outcome;
  };

  return { busyApprovalId, error, decide, clearError: () => setError(null) };
}
