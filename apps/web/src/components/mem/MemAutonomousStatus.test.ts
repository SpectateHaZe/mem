import type { MemWatchedThread } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeAutonomy, describeAutonomyBrief } from "./MemAutonomousStatus";

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

  it("names a usage limit only when that is what Mem waits for", () => {
    const text = describeAutonomy([watched({ waitingUntilMs: 10, waitingFor: null })], 0);
    expect(text).toContain("is paused until");
    expect(text).not.toContain("usage limit");
  });

  it("says parked work is parked instead of asking for a session", () => {
    const text = describeAutonomy([watched({ phase: "parked" })], 0);
    expect(text).toContain("1 session is parked");
    expect(text).not.toContain("In progress");
  });
});

describe("describeAutonomyBrief", () => {
  it("counts only the sessions still working", () => {
    const text = describeAutonomyBrief(
      [
        watched({ roundSummaries: ["darker sidebar"] }),
        watched({ threadId: "u", waitingUntilMs: 10, waitingFor: "usage" }),
      ],
      0,
    );
    expect(text).toBe("working on 1 session");
  });

  it("says when the only session waits", () => {
    const resetMs = new Date(2026, 10, 16, 14, 20).getTime();
    const text = describeAutonomyBrief(
      [watched({ waitingUntilMs: resetMs, waitingFor: "budget" })],
      resetMs - 60_000,
    );
    expect(text).toBe(
      `waiting until ${new Date(resetMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
    );
  });

  it("says there is nothing to work on", () => {
    expect(describeAutonomyBrief([watched({ phase: "accepted" })], 0)).toBe(
      "mark a session in progress",
    );
  });

  it("counts parked sessions instead of claiming the queue is empty", () => {
    const text = describeAutonomyBrief(
      [watched({ phase: "parked" }), watched({ threadId: "u", phase: "parked" })],
      0,
    );
    expect(text).toBe("2 sessions parked");
  });
});
