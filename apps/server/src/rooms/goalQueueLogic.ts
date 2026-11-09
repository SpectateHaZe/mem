import type { GoalQueue, OrchestrationV2Run, QueueGoal, QueueGoalId } from "@t3tools/contracts";

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

/** What a goal becomes once its run has ended. `heldBack` is a pause or the spending cap. */
export const settleGoal = (
  goal: QueueGoal,
  runStatus: OrchestrationV2Run["status"],
  heldBack: boolean,
): QueueGoal => {
  const { note: _note, ...cleared } = goal;
  if (runStatus === "completed") return { ...cleared, status: "done" };
  // The run was stopped on purpose, so this isn't a failure to retry.
  if (heldBack) return { ...cleared, status: "pending" };
  if (runStatus === "failed") return recordFailedRun(cleared, "the run failed.");
  return { ...cleared, status: "failed", note: `Stopped (${runStatus}).` };
};

export const goalPrompt = (goal: QueueGoal) =>
  goal.attempts === 0 && goal.threadId === undefined
    ? `${goal.text}\n\nYou are working unattended from a queue, so nobody can answer questions. Make reasonable assumptions, finish the goal, and end by saying what you did and what is left undone.`
    : `The previous attempt stopped before finishing. Check what is already done, then finish this goal:\n\n${goal.text}`;
