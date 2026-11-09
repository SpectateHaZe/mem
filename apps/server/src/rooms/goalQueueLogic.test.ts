import { assert, it } from "@effect/vitest";
import type { GoalQueue, QueueGoal } from "@t3tools/contracts";

import { goalPrompt, nextPendingGoal, settleGoal } from "./goalQueueLogic.ts";

const goal = (overrides: Partial<QueueGoal> = {}) =>
  ({
    id: "a",
    projectId: "p",
    text: "Ship it",
    status: "running",
    attempts: 0,
    ...overrides,
  }) as QueueGoal;

it("works one goal at a time and not while paused", () => {
  const pending = goal({ id: "b" as QueueGoal["id"], status: "pending" });
  const queue = (goals: QueueGoal[], paused = false): GoalQueue => ({ goals, paused });
  assert.equal(nextPendingGoal(queue([goal({ status: "done" }), pending]))?.id, pending.id);
  assert.equal(nextPendingGoal(queue([goal(), pending])), undefined);
  assert.equal(nextPendingGoal(queue([pending], true)), undefined);
});

it("retries failed runs, then gives up so the queue can move on", () => {
  assert.equal(settleGoal(goal(), "failed", false).status, "pending");
  const last = settleGoal(goal({ attempts: 2 }), "failed", false);
  assert.equal(last.status, "failed");
  assert.equal(last.attempts, 3);
});

it("requeues a goal stopped by a pause or the cap without using up a try", () => {
  const held = settleGoal(goal(), "interrupted", true);
  assert.equal(held.status, "pending");
  assert.equal(held.attempts, 0);
});

it("does not retry a run someone stopped by hand", () => {
  assert.equal(settleGoal(goal(), "interrupted", false).status, "failed");
});

it("marks completed goals done even if the queue was paused meanwhile", () => {
  assert.equal(settleGoal(goal({ note: "Retrying" }), "completed", true).status, "done");
});

it("tells a resumed goal to pick up existing work", () => {
  assert.include(goalPrompt(goal()), "unattended");
  assert.include(goalPrompt(goal({ threadId: "t" as QueueGoal["threadId"] })), "previous attempt");
});
