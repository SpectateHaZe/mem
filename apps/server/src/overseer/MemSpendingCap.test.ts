import { describe, expect, it } from "vite-plus/test";

import {
  accrueSpend,
  decideSpend,
  describeCap,
  MEM_SPEND_WINDOW_MS,
  parkAtCap,
  pruneSpendEntries,
  sumSpendInWindow,
  toCents,
  type SpendDecision,
} from "./MemSpendingCap.ts";

const rejected = (reason: "cap_reached" | "estimate_exceeds_cap" | "cap_disabled") =>
  expect.objectContaining({ allowed: false, reason });

describe("toCents", () => {
  it("rounds to whole cents", () => {
    expect(toCents(1.84)).toBe(184);
    expect(toCents(1.005)).toBe(101);
    expect(toCents(0.1 + 0.2)).toBe(30);
  });

  it("maps non-finite input to zero", () => {
    expect(toCents(Number.NaN)).toBe(0);
    expect(toCents(Number.POSITIVE_INFINITY)).toBe(0);
    expect(toCents(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe("decideSpend", () => {
  it("allows a turn whose estimate fits under the cap", () => {
    const decision: SpendDecision = decideSpend({
      capUsd: 5,
      spentUsd: 1,
      estimatedNextTurnUsd: 0.5,
    });
    expect(decision).toEqual({ allowed: true, remainingCents: 350 });
  });

  it("rejects a turn that lands exactly on the cap", () => {
    expect(decideSpend({ capUsd: 5, spentUsd: 4, estimatedNextTurnUsd: 1 })).toEqual(
      rejected("estimate_exceeds_cap"),
    );
  });

  it("rejects an estimate that overshoots by one cent", () => {
    expect(decideSpend({ capUsd: 5, spentUsd: 4.99, estimatedNextTurnUsd: 0.02 })).toEqual(
      rejected("estimate_exceeds_cap"),
    );
  });

  it("rejects once spent has reached the cap", () => {
    expect(decideSpend({ capUsd: 5, spentUsd: 5, estimatedNextTurnUsd: 0 })).toEqual(
      rejected("cap_reached"),
    );
    expect(decideSpend({ capUsd: 5, spentUsd: 7.5, estimatedNextTurnUsd: 0 })).toEqual(
      rejected("cap_reached"),
    );
  });

  it("treats a zero cap as no budget, never as unlimited", () => {
    expect(decideSpend({ capUsd: 0, spentUsd: 0, estimatedNextTurnUsd: 0 })).toEqual(
      rejected("cap_disabled"),
    );
  });

  it("treats a negative cap as no budget", () => {
    expect(decideSpend({ capUsd: -5, spentUsd: 0, estimatedNextTurnUsd: 0.01 })).toEqual(
      rejected("cap_disabled"),
    );
  });

  it("treats a non-finite cap as no budget", () => {
    expect(decideSpend({ capUsd: Number.NaN, spentUsd: 0, estimatedNextTurnUsd: 0 })).toEqual(
      rejected("cap_disabled"),
    );
  });

  it("treats NaN spend and estimate as zero", () => {
    expect(decideSpend({ capUsd: 5, spentUsd: Number.NaN, estimatedNextTurnUsd: 1 })).toEqual({
      allowed: true,
      remainingCents: 400,
    });
    expect(decideSpend({ capUsd: 5, spentUsd: 1, estimatedNextTurnUsd: Number.NaN })).toEqual({
      allowed: true,
      remainingCents: 400,
    });
  });

  it("ignores a negative estimate instead of minting budget", () => {
    expect(decideSpend({ capUsd: 5, spentUsd: 4.99, estimatedNextTurnUsd: -1 })).toEqual({
      allowed: true,
      remainingCents: 1,
    });
  });
});

describe("accrueSpend", () => {
  it("adds the reported cost in whole cents", () => {
    expect(accrueSpend({ spentUsd: 1, actualUsd: 0.42 })).toEqual({ spentUsd: 1.42 });
  });

  it("keeps float-drift sums exact", () => {
    let spentUsd = 0;
    for (const cost of [0.1, 0.2, 0.3]) {
      spentUsd = accrueSpend({ spentUsd, actualUsd: cost }).spentUsd;
    }
    expect(spentUsd).toBe(0.6);
    expect(spentUsd).not.toBe(0.1 + 0.2 + 0.3);
  });

  it("ignores a negative actual so a bad report cannot give budget back", () => {
    expect(accrueSpend({ spentUsd: 1.5, actualUsd: -2 })).toEqual({ spentUsd: 1.5 });
  });

  it("ignores a non-finite actual", () => {
    expect(accrueSpend({ spentUsd: 1.5, actualUsd: Number.NaN })).toEqual({ spentUsd: 1.5 });
    expect(accrueSpend({ spentUsd: 1.5, actualUsd: Number.POSITIVE_INFINITY })).toEqual({
      spentUsd: 1.5,
    });
  });
});

describe("parkAtCap", () => {
  it("parks nothing below the cap", () => {
    expect(parkAtCap({ capUsd: 5, spentUsd: 4.99, claimedTaskIds: ["a", "b"] })).toEqual({
      shouldPark: false,
      parkedTaskIds: [],
    });
  });

  it("parks every claimed task at or over the cap", () => {
    expect(parkAtCap({ capUsd: 5, spentUsd: 5, claimedTaskIds: ["a", "b"] })).toEqual({
      shouldPark: true,
      parkedTaskIds: ["a", "b"],
    });
    expect(parkAtCap({ capUsd: 5, spentUsd: 6, claimedTaskIds: ["a"] })).toEqual({
      shouldPark: true,
      parkedTaskIds: ["a"],
    });
  });

  it("parks everything when the cap is disabled", () => {
    expect(parkAtCap({ capUsd: 0, spentUsd: 0, claimedTaskIds: ["a"] })).toEqual({
      shouldPark: true,
      parkedTaskIds: ["a"],
    });
  });

  it("is idempotent, keeps order, and drops duplicates", () => {
    const claimedTaskIds = ["a", "b", "a", "c"];
    const first = parkAtCap({ capUsd: 5, spentUsd: 5, claimedTaskIds });
    const second = parkAtCap({ capUsd: 5, spentUsd: 5, claimedTaskIds });

    expect(first.parkedTaskIds).toEqual(["a", "b", "c"]);
    expect(second).toEqual(first);
    expect(parkAtCap({ capUsd: 5, spentUsd: 5, claimedTaskIds: first.parkedTaskIds })).toEqual(
      first,
    );
  });
});

describe("sumSpendInWindow", () => {
  const nowMs = 1_700_000_000_000;

  it("sums only the entries inside the rolling day", () => {
    expect(
      sumSpendInWindow({
        entries: [
          { atMs: nowMs - MEM_SPEND_WINDOW_MS - 1, usd: 4, threadId: "old" },
          { atMs: nowMs - MEM_SPEND_WINDOW_MS, usd: 2, threadId: "boundary" },
          { atMs: nowMs - 60_000, usd: 0.25, threadId: "fresh" },
          { atMs: nowMs, usd: 0.05, threadId: "now" },
        ],
        nowMs,
      }),
    ).toBe(0.3);
  });

  it("carries the sum in whole cents and drops nonsense entries", () => {
    expect(
      sumSpendInWindow({
        entries: [
          { atMs: nowMs, usd: 0.1, threadId: "a" },
          { atMs: nowMs, usd: 0.2, threadId: "b" },
          { atMs: nowMs, usd: -5, threadId: "bad-negative" },
          { atMs: nowMs, usd: Number.NaN, threadId: "bad-nan" },
          { atMs: Number.NaN, usd: 9, threadId: "bad-time" },
        ],
        nowMs,
      }),
    ).toBe(0.3);
  });

  it("prunes to exactly the entries the cap still counts", () => {
    const fresh = { atMs: nowMs - 1, usd: 0.1, threadId: "fresh" };
    expect(
      pruneSpendEntries({
        entries: [{ atMs: nowMs - MEM_SPEND_WINDOW_MS - 1, usd: 1, threadId: "old" }, fresh],
        nowMs,
      }),
    ).toStrictEqual([fresh]);
  });
});

describe("describeCap", () => {
  it("floors the percentage", () => {
    expect(describeCap({ capUsd: 5, spentUsd: 1.84 })).toBe(
      "Mem spent $1.84 of its $5.00 cap (36%)",
    );
  });

  it("never shows 100% before the cap is reached", () => {
    expect(describeCap({ capUsd: 5, spentUsd: 4.99 })).toBe(
      "Mem spent $4.99 of its $5.00 cap (99%)",
    );
  });

  it("shows 100% once the cap is reached", () => {
    expect(describeCap({ capUsd: 5, spentUsd: 5 })).toBe("Mem spent $5.00 of its $5.00 cap (100%)");
    expect(describeCap({ capUsd: 5, spentUsd: 9 })).toBe("Mem spent $9.00 of its $5.00 cap (100%)");
  });

  it("says the cap is disabled when there is no budget", () => {
    expect(describeCap({ capUsd: 0, spentUsd: 1.2 })).toBe("Mem spent $1.20 (cap disabled)");
    expect(describeCap({ capUsd: -1, spentUsd: 0 })).toBe("Mem spent $0.00 (cap disabled)");
  });
});
