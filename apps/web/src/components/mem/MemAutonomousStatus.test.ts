import type { MemWatchedThread } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeAutonomy } from "./MemAutonomousStatus";

const watched = (overrides: Partial<MemWatchedThread>): MemWatchedThread => ({
  threadId: "t",
  phase: "claimed",
  rejections: 0,
  lastInstruction: null,
  spendUsd: 0,
  pendingApproval: false,
  sentInstruction: null,
  sentAtMs: null,
  priority: "normal",
  waitingUntilMs: null,
  waitingFor: null,
  roundSummaries: [],
  ...overrides,
});

describe("describeAutonomy", () => {
  it("asks for an in-progress session when there is none", () => {
    expect(describeAutonomy([watched({ phase: "accepted" })], 0)).toContain("In progress");
  });

  it("counts working sessions, waits, and rounds", () => {
    const text = describeAutonomy(
      [
        watched({ roundSummaries: ["darker sidebar"] }),
        watched({ threadId: "u", waitingUntilMs: 10, waitingFor: "usage" }),
      ],
      0,
    );
    expect(text).toContain("Working on 1 session.");
    expect(text).toContain("waits for its usage limit");
    expect(text).toContain("Latest: darker sidebar");
  });
});
