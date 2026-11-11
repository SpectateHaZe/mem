/**
 * The Mem overseer's model choice: follow the owner's weekly pace, or always spend on the premium
 * tier. Pure so the decision is testable without usage I/O.
 *
 * Unknown usage resolves to the premium model. Mem does not quietly economise on the owner's behalf
 * when it cannot measure the week, and every branch carries a short reason for the run summary.
 */

import type { ModelSelection } from "@t3tools/contracts";

export type MemPaceMode = "on_pace" | "full";

export interface MemPaceInputs {
  readonly paceMode: MemPaceMode;
  readonly premium: ModelSelection | null;
  readonly economy: ModelSelection | null;
  /** Fraction of the weekly limit already spent, 0..1; null when usage is unknown. */
  readonly usedFraction: number | null;
  /** Fraction of the week elapsed, 0..1; null when the window is unknown. */
  readonly elapsedFraction: number | null;
}

export type MemPaceDecision =
  | { readonly kind: "premium"; readonly selection: ModelSelection; readonly reason: string }
  | { readonly kind: "economy"; readonly selection: ModelSelection; readonly reason: string }
  | { readonly kind: "unset"; readonly reason: string };

/** Percentage points of spend above the week's elapsed share before Mem economises. */
export const MEM_PACE_TOLERANCE = 0.05;

const clampFraction = (value: number | null): number | null => {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
};

const percent = (fraction: number): number => Math.round(fraction * 100);

const nothingSet = (): MemPaceDecision => ({
  kind: "unset",
  reason: "no premium or economy model is set",
});

export const chooseModel = (inputs: MemPaceInputs): MemPaceDecision => {
  const { premium, economy } = inputs;
  if (premium === null && economy === null) return nothingSet();

  // Full mode never reads the week: the owner asked for the premium model, so it is the model.
  if (inputs.paceMode === "full") {
    if (premium !== null) {
      return {
        kind: "premium",
        selection: premium,
        reason: "full mode always uses the premium model",
      };
    }
    if (economy !== null) {
      return {
        kind: "economy",
        selection: economy,
        reason: "full mode, but no premium model is set",
      };
    }
    return nothingSet();
  }

  const used = clampFraction(inputs.usedFraction);
  const elapsed = clampFraction(inputs.elapsedFraction);

  // Without both fractions there is no pace to judge, and guessing would spend the owner's budget.
  if (used === null || elapsed === null) {
    if (premium !== null) {
      return { kind: "premium", selection: premium, reason: "pace could not be measured" };
    }
    if (economy !== null) {
      return {
        kind: "economy",
        selection: economy,
        reason: "pace could not be measured, and no premium model is set",
      };
    }
    return nothingSet();
  }

  const week = `${percent(used)}% spent, ${percent(elapsed)}% of week elapsed`;
  if (used > elapsed + MEM_PACE_TOLERANCE) {
    if (economy !== null) {
      return { kind: "economy", selection: economy, reason: `ahead of pace (${week})` };
    }
    if (premium !== null) {
      return {
        kind: "premium",
        selection: premium,
        reason: `ahead of pace (${week}), but no economy model is set`,
      };
    }
    return nothingSet();
  }

  if (premium !== null) {
    return { kind: "premium", selection: premium, reason: `on pace (${week})` };
  }
  if (economy !== null) {
    return {
      kind: "economy",
      selection: economy,
      reason: `on pace (${week}), but no premium model is set`,
    };
  }
  return nothingSet();
};
