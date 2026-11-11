import { describe, expect, it } from "vite-plus/test";

import {
  nextAction,
  reduceTask,
  startTask,
  type MemLoopInputs,
  type MemTaskState,
} from "./MemOverseerLoop.ts";
import type { QualityGateResult } from "./MemQualityGate.ts";

const IDLE_AWAY: MemLoopInputs = { threadIdle: true, ownerAway: true, budgetAllowsTurn: true };

const review = (overrides: Partial<QualityGateResult>): QualityGateResult => ({
  verdict: "accept",
  findings: [],
  reasoning: "",
  nextInstruction: null,
  usable: true,
  ...overrides,
});

const advance = (events: ReadonlyArray<Parameters<typeof reduceTask>[1]>): MemTaskState =>
  events.reduce(reduceTask, startTask("thread-1"));

describe("Mem overseer task machine", () => {
  it("waits on a claimed task until there is an instruction to send", () => {
    expect(nextAction(startTask("thread-1"), IDLE_AWAY)).toStrictEqual({ type: "wait" });
  });

  it("reviews a completed turn, then accepts", () => {
    const afterTurn = advance([{ type: "turnEnded", status: "completed" }]);
    expect(afterTurn.phase).toBe("awaitingReview");
    expect(nextAction(afterTurn, IDLE_AWAY)).toStrictEqual({ type: "review" });

    const accepted = reduceTask(afterTurn, {
      type: "reviewed",
      result: review({ verdict: "accept" }),
    });
    expect(accepted.phase).toBe("accepted");
    expect(nextAction(accepted, IDLE_AWAY)).toStrictEqual({ type: "accept" });
  });

  it("sends the rejection instruction back and counts the round", () => {
    const rejected = advance([
      { type: "turnEnded", status: "completed" },
      {
        type: "reviewed",
        result: review({ verdict: "reject", nextInstruction: "Bound the retry loop." }),
      },
    ]);
    expect(rejected.phase).toBe("claimed");
    expect(rejected.rejections).toBe(1);
    expect(nextAction(rejected, IDLE_AWAY)).toStrictEqual({
      type: "guide",
      instruction: "Bound the retry loop.",
      mode: "act",
    });
  });

  it("escalates a rejection that carries no instruction instead of looping", () => {
    const state = advance([
      { type: "turnEnded", status: "completed" },
      { type: "reviewed", result: review({ verdict: "reject", nextInstruction: null }) },
    ]);
    expect(state.phase).toBe("escalated");
    expect(nextAction(state, IDLE_AWAY)).toStrictEqual({
      type: "escalate",
      reason: "the review could not be applied to this task",
    });
  });

  it("escalates an unusable review rather than treating it as acceptance", () => {
    const state = advance([
      { type: "turnEnded", status: "completed" },
      { type: "reviewed", result: review({ verdict: "reject", usable: false }) },
    ]);
    expect(state.phase).toBe("escalated");
  });

  it("parks instead of guiding when the budget cannot fund another turn", () => {
    const state = advance([
      { type: "turnEnded", status: "completed" },
      { type: "reviewed", result: review({ verdict: "reject", nextInstruction: "Fix the test." }) },
    ]);
    const action = nextAction(state, { ...IDLE_AWAY, budgetAllowsTurn: false });
    expect(action).toStrictEqual({ type: "park", reason: "no budget for another turn" });
  });

  it("asks instead of acting while the owner is at the machine", () => {
    const state = advance([
      { type: "turnEnded", status: "completed" },
      { type: "reviewed", result: review({ verdict: "reject", nextInstruction: "Rename it." }) },
    ]);
    expect(nextAction(state, { ...IDLE_AWAY, ownerAway: false })).toStrictEqual({
      type: "guide",
      instruction: "Rename it.",
      mode: "ask",
    });
  });

  it("waits for an in-flight turn rather than interrupting it", () => {
    expect(nextAction(startTask("t"), { ...IDLE_AWAY, threadIdle: false })).toStrictEqual({
      type: "wait",
    });
  });

  it("parks on the cap and never resumes on its own", () => {
    const parked = advance([
      { type: "turnEnded", status: "completed" },
      { type: "capReached" },
      { type: "reviewed", result: review({ verdict: "reject", nextInstruction: "try again" }) },
    ]);
    expect(parked.phase).toBe("parked");
    expect(nextAction(parked, IDLE_AWAY)).toStrictEqual({
      type: "park",
      reason: "spending cap reached",
    });
  });

  it("keeps an accepted task accepted", () => {
    const accepted = advance([
      { type: "turnEnded", status: "completed" },
      { type: "reviewed", result: review({ verdict: "accept" }) },
      { type: "turnEnded", status: "failed" },
      { type: "capReached" },
    ]);
    expect(accepted.phase).toBe("accepted");
  });
});
