import type { MemWatchedThread } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { escalatedThreads } from "./MemEscalations";

const watched = (overrides: Partial<MemWatchedThread>): MemWatchedThread => ({
  threadId: "t",
  phase: "escalated",
  rejections: 1,
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

it("lists the most-rejected escalations first and caps the banner", () => {
  const listed = escalatedThreads([
    watched({ threadId: "a", rejections: 2 }),
    watched({ threadId: "b", phase: "claimed", rejections: 9 }),
    watched({ threadId: "c", rejections: 4 }),
    watched({ threadId: "d", rejections: 1 }),
    watched({ threadId: "e", rejections: 3 }),
  ]);
  expect(listed.map((thread) => thread.threadId)).toEqual(["c", "e", "a"]);
});
