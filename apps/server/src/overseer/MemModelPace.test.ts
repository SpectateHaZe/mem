import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { chooseModel, MEM_PACE_TOLERANCE, type MemPaceInputs } from "./MemModelPace.ts";

const premium: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-6",
};

const economy: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-4-5",
};

const pace = (overrides: Partial<MemPaceInputs> = {}): MemPaceInputs => ({
  paceMode: "on_pace",
  premium,
  economy,
  usedFraction: 0.3,
  elapsedFraction: 0.5,
  ...overrides,
});

describe("chooseModel full mode", () => {
  it("always uses the premium model and ignores the pace", () => {
    const decision = chooseModel(
      pace({ paceMode: "full", usedFraction: 0.99, elapsedFraction: 0.01 }),
    );
    expect(decision).toEqual({
      kind: "premium",
      selection: premium,
      reason: "full mode always uses the premium model",
    });
  });

  it("falls back to the economy model when no premium model is set", () => {
    expect(chooseModel(pace({ paceMode: "full", premium: null }))).toEqual({
      kind: "economy",
      selection: economy,
      reason: "full mode, but no premium model is set",
    });
  });
});

describe("chooseModel on pace", () => {
  it("keeps the premium model while spending tracks the week", () => {
    expect(chooseModel(pace())).toEqual({
      kind: "premium",
      selection: premium,
      reason: "on pace (30% spent, 50% of week elapsed)",
    });
  });

  it("drops to the economy model when spending runs ahead", () => {
    expect(chooseModel(pace({ usedFraction: 0.62, elapsedFraction: 0.4 }))).toEqual({
      kind: "economy",
      selection: economy,
      reason: "ahead of pace (62% spent, 40% of week elapsed)",
    });
  });

  it("treats the tolerance as the boundary, not as headroom past it", () => {
    expect(
      chooseModel(pace({ usedFraction: 0.4 + MEM_PACE_TOLERANCE, elapsedFraction: 0.4 })),
    ).toMatchObject({ kind: "premium" });
    expect(
      chooseModel(pace({ usedFraction: 0.4 + MEM_PACE_TOLERANCE + 0.001, elapsedFraction: 0.4 })),
    ).toMatchObject({ kind: "economy" });
  });

  it("stays on the premium model when the economy model is not set", () => {
    expect(chooseModel(pace({ economy: null, usedFraction: 0.9, elapsedFraction: 0.1 }))).toEqual({
      kind: "premium",
      selection: premium,
      reason: "ahead of pace (90% spent, 10% of week elapsed), but no economy model is set",
    });
  });

  it("uses the economy model while under pace when the premium model is not set", () => {
    expect(chooseModel(pace({ premium: null }))).toEqual({
      kind: "economy",
      selection: economy,
      reason: "on pace (30% spent, 50% of week elapsed), but no premium model is set",
    });
  });
});

describe("chooseModel unknown usage", () => {
  it("keeps the premium model when usage is unknown", () => {
    expect(chooseModel(pace({ usedFraction: null }))).toEqual({
      kind: "premium",
      selection: premium,
      reason: "pace could not be measured",
    });
    expect(chooseModel(pace({ elapsedFraction: null }))).toMatchObject({ kind: "premium" });
  });

  it("treats non-finite fractions as unknown", () => {
    expect(chooseModel(pace({ usedFraction: Number.NaN }))).toMatchObject({ kind: "premium" });
    expect(chooseModel(pace({ elapsedFraction: Number.POSITIVE_INFINITY }))).toMatchObject({
      kind: "premium",
    });
    expect(chooseModel(pace({ usedFraction: Number.NEGATIVE_INFINITY }))).toMatchObject({
      kind: "premium",
    });
  });

  it("falls back to the economy model when the premium model is not set", () => {
    expect(chooseModel(pace({ premium: null, usedFraction: null }))).toEqual({
      kind: "economy",
      selection: economy,
      reason: "pace could not be measured, and no premium model is set",
    });
  });
});

describe("chooseModel clamping", () => {
  it("clamps fractions into 0..1 before judging pace", () => {
    expect(chooseModel(pace({ usedFraction: 1.4, elapsedFraction: 0.4 }))).toMatchObject({
      kind: "economy",
      reason: "ahead of pace (100% spent, 40% of week elapsed)",
    });
    expect(chooseModel(pace({ usedFraction: 0.2, elapsedFraction: 1.9 }))).toMatchObject({
      kind: "premium",
      reason: "on pace (20% spent, 100% of week elapsed)",
    });
    expect(chooseModel(pace({ usedFraction: -0.2, elapsedFraction: -0.1 }))).toMatchObject({
      kind: "premium",
      reason: "on pace (0% spent, 0% of week elapsed)",
    });
  });
});

describe("chooseModel unset", () => {
  it("reports unset when neither tier has a model", () => {
    expect(chooseModel(pace({ premium: null, economy: null, paceMode: "full" }))).toEqual({
      kind: "unset",
      reason: "no premium or economy model is set",
    });
  });
});
