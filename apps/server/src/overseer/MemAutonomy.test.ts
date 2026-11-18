import { describe, expect, it } from "vite-plus/test";

import {
  byPriority,
  improvementInstruction,
  MEM_AUTONOMOUS_RETRY_MS,
  MEM_USAGE_RESET_SLACK_MS,
  roundSummary,
  usageWaitUntil,
} from "./MemAutonomy.ts";

describe("MemAutonomy", () => {
  it("takes the agent's Improved line, else the review's reasoning", () => {
    expect(roundSummary("Did things.\n**Improved: darker sidebar**", "Fine.")).toBe(
      "darker sidebar",
    );
    expect(roundSummary("Did things.\nMade the sidebar darker.", "Verified.")).toBe(
      "Made the sidebar darker.",
    );
    expect(roundSummary("", "Verified the sidebar.\nMore.")).toBe("Verified the sidebar.");
    expect(roundSummary("", null)).toBe("Change with no summary");
  });

  it("lists recent rounds so the next one won't repeat them", () => {
    expect(improvementInstruction([])).not.toContain("recent rounds");
    expect(improvementInstruction(["a", "b"])).toContain("- a\n- b");
  });

  it("waits for the latest reset of every full window", () => {
    const now = 1_000;
    expect(
      usageWaitUntil({ limited: false, windows: [{ usedPercent: 50, resetsAtMs: 9 }] }, now),
    ).toBeNull();
    expect(
      usageWaitUntil(
        {
          limited: true,
          windows: [
            { usedPercent: 100, resetsAtMs: 5_000 },
            { usedPercent: 100, resetsAtMs: 9_000 },
          ],
        },
        now,
      ),
    ).toBe(9_000 + MEM_USAGE_RESET_SLACK_MS);
    // A limited run with no known reset retries on the plain interval.
    expect(usageWaitUntil({ limited: true, windows: [] }, now)).toBe(now + MEM_AUTONOMOUS_RETRY_MS);
    // The failure's own reset is when limit recovery resumes it, so Mem waits for that.
    expect(usageWaitUntil({ limited: true, windows: [], limitResetAtMs: 4_000 }, now)).toBe(
      4_000 + MEM_USAGE_RESET_SLACK_MS,
    );
    expect(usageWaitUntil({ limited: true, windows: [], limitResetAtMs: 500 }, now)).toBe(
      now + MEM_AUTONOMOUS_RETRY_MS,
    );
  });

  it("orders high before normal before low, keeping ties in place", () => {
    const items = [
      { id: "a", p: "low" },
      { id: "b", p: "normal" },
      { id: "c", p: "high" },
      { id: "d", p: "normal" },
    ] as const;
    expect(byPriority(items, (item) => item.p).map((item) => item.id)).toStrictEqual([
      "c",
      "b",
      "d",
      "a",
    ]);
  });
});
