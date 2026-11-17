import { describe, expect, it } from "vite-plus/test";

import { makeEndedRunTracker } from "./endedRuns.ts";

describe("makeEndedRunTracker", () => {
  it("acts on a run once, however often it is re-sent", () => {
    const firstEnd = makeEndedRunTracker();
    expect(firstEnd("run-1")).toBe(true);
    expect(firstEnd("run-1")).toBe(false);
    expect(firstEnd("run-2")).toBe(true);
  });

  it("forgets the oldest ids past its limit", () => {
    const firstEnd = makeEndedRunTracker(2);
    firstEnd("run-1");
    firstEnd("run-2");
    firstEnd("run-3");
    expect(firstEnd("run-1")).toBe(true);
    expect(firstEnd("run-3")).toBe(false);
  });
});
