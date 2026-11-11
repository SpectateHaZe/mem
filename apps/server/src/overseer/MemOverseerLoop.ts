import type { QualityGateResult } from "./MemQualityGate.ts";

/**
 * The overseer's per-task state machine. Pure on purpose: the loop that drives it touches provider
 * sessions, budgets, and the disk, and none of that should be reachable from a transition.
 */
export type MemTaskPhase = "claimed" | "awaitingReview" | "accepted" | "escalated" | "parked";

export interface MemTaskState {
  readonly threadId: string;
  readonly phase: MemTaskPhase;
  /** Reject-and-retry rounds so far; the guard against an agent that never satisfies the rubric. */
  readonly rejections: number;
  /** The last instruction handed back to the session, kept so a repeat defect is named. */
  readonly lastInstruction: string | null;
}

export type MemTaskEvent =
  | { readonly type: "turnEnded"; readonly status: "completed" | "failed" }
  | { readonly type: "reviewed"; readonly result: QualityGateResult }
  | { readonly type: "capReached" };

export interface MemLoopInputs {
  /** False while the thread is still working; the loop waits rather than interrupting. */
  readonly threadIdle: boolean;
  readonly ownerAway: boolean;
  readonly budgetAllowsTurn: boolean;
}

export type MemLoopAction =
  | { readonly type: "wait" }
  | { readonly type: "review" }
  /**
   * `ask` runs while the owner is present: Mem proposes the correction and waits for a human.
   * `act` runs while the owner is away: Mem sends its own recommendation without asking.
   */
  | { readonly type: "guide"; readonly instruction: string; readonly mode: "ask" | "act" }
  | { readonly type: "accept" }
  | { readonly type: "escalate"; readonly reason: string }
  | { readonly type: "park"; readonly reason: string };

export const startTask = (threadId: string): MemTaskState => ({
  threadId,
  phase: "claimed",
  rejections: 0,
  lastInstruction: null,
});

const isTerminal = (phase: MemTaskPhase): boolean => phase === "accepted" || phase === "parked";

/**
 * Terminal phases ignore every later event: an accepted task must not be dragged back into review
 * by a stray event, and a parked one must not resume on its own.
 */
export const reduceTask = (state: MemTaskState, event: MemTaskEvent): MemTaskState => {
  if (isTerminal(state.phase)) return state;
  switch (event.type) {
    case "capReached":
      return { ...state, phase: "parked" };
    case "turnEnded":
      // A failed turn still gets reviewed: the failure itself is evidence the session stopped.
      return { ...state, phase: "awaitingReview" };
    case "reviewed": {
      const { result } = event;
      if (!result.usable) {
        return { ...state, phase: "escalated", lastInstruction: null };
      }
      if (result.verdict === "accept") {
        return { ...state, phase: "accepted" };
      }
      // Rejecting without an instruction cannot guide a session, so it goes to a human instead of
      // looping on the same prompt.
      if (result.nextInstruction === null || result.nextInstruction.trim() === "") {
        return { ...state, phase: "escalated", lastInstruction: null };
      }
      return {
        ...state,
        phase: "claimed",
        rejections: state.rejections + 1,
        lastInstruction: result.nextInstruction,
      };
    }
  }
};

export const nextAction = (state: MemTaskState, inputs: MemLoopInputs): MemLoopAction => {
  switch (state.phase) {
    case "accepted":
      return { type: "accept" };
    case "parked":
      return { type: "park", reason: "spending cap reached" };
    case "escalated":
      return { type: "escalate", reason: "the review could not be applied to this task" };
    case "awaitingReview":
      return { type: "review" };
    case "claimed": {
      if (!inputs.threadIdle) return { type: "wait" };
      if (!inputs.budgetAllowsTurn) return { type: "park", reason: "no budget for another turn" };
      if (state.lastInstruction === null) return { type: "wait" };
      return {
        type: "guide",
        instruction: state.lastInstruction,
        mode: inputs.ownerAway ? "act" : "ask",
      };
    }
  }
};
