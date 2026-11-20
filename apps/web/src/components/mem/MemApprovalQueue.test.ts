import { describe, expect, it } from "vite-plus/test";

import { describeWaited } from "./MemApprovalQueue";

const NOW = new Date(2026, 10, 20, 12, 0).getTime();

describe("describeWaited", () => {
  it("never counts backwards when the clock is behind the approval", () => {
    expect(describeWaited(NOW + 60_000, NOW)).toBe("waiting a moment");
    expect(describeWaited(NOW - 20_000, NOW)).toBe("waiting a moment");
  });

  it("counts minutes, hours and days", () => {
    expect(describeWaited(NOW - 5 * 60_000, NOW)).toBe("waiting 5m");
    expect(describeWaited(NOW - 3 * 60 * 60_000, NOW)).toBe("waiting 3h");
    expect(describeWaited(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe("waiting 2d");
  });
});
