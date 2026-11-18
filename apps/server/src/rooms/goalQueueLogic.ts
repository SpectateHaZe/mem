import type { GoalQueue, OrchestrationV2Run, QueueGoal, QueueGoalId } from "@t3tools/contracts";

import type { LimitStop } from "./limitStops.ts";

const MAX_FAILED_RUNS = 3;

export const nextPendingGoal = (queue: GoalQueue) =>
  queue.paused || queue.goals.some((goal) => goal.status === "running")
    ? undefined
    : queue.goals.find((goal) => goal.status === "pending");

export const updateGoal = (
  queue: GoalQueue,
  goalId: QueueGoalId,
  update: (goal: QueueGoal) => QueueGoal,
): GoalQueue => ({
  ...queue,
  goals: queue.goals.map((goal) => (goal.id === goalId ? update(goal) : goal)),
});

export const recordFailedRun = (goal: QueueGoal, reason: string): QueueGoal => {
  const attempts = goal.attempts + 1;
  return attempts >= MAX_FAILED_RUNS
    ? { ...goal, attempts, status: "failed", note: `Gave up after ${attempts} tries: ${reason}` }
    : { ...goal, attempts, status: "pending", note: `Retrying: ${reason}` };
};

export const LIMIT_WAIT_NOTE =
  "Paused: a usage limit stopped the goal. Resume the queue after it resets.";

/** What a goal becomes once its run has ended. `heldBack` is a pause or the spending cap. */
export const settleGoal = (
  goal: QueueGoal,
  runStatus: OrchestrationV2Run["status"],
  heldBack: boolean,
  limit: LimitStop = null,
): QueueGoal => {
  const { note: _note, ...cleared } = goal;
  if (runStatus === "completed") return { ...cleared, status: "done" };
  // A limit is not the goal's fault: retrying into it would burn every try within seconds.
  if (runStatus === "failed" && limit === "resumes") {
    return { ...goal, note: "Waiting for the usage limit to reset; it continues on its own." };
  }
  if (runStatus === "failed" && limit === "waits") return { ...cleared, status: "pending" };
  // The run was stopped on purpose, so this isn't a failure to retry. A restart or shutdown
  // cancels every live run; the goal picks up again on its own thread, not as a failure.
  if (heldBack || runStatus === "cancelled") return { ...cleared, status: "pending" };
  if (runStatus === "failed") return recordFailedRun(cleared, "the run failed.");
  return { ...cleared, status: "failed", note: `Stopped (${runStatus}).` };
};

export const goalPrompt = (goal: QueueGoal) =>
  goal.attempts === 0 && goal.threadId === undefined
    ? `${goal.text}\n\nYou are working unattended from a queue, so nobody can answer questions. Make reasonable assumptions, finish the goal, and end by saying what you did and what is left undone.`
    : `The previous attempt stopped before finishing. Check what is already done, then finish this goal:\n\n${goal.text}`;
