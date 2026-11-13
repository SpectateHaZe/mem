import type { MemWatchedThread } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { recentSentMessages } from "./MemSentMessages";

const thread = (threadId: string, sentAtMs: number | null): MemWatchedThread => ({
  threadId,
  phase: "claimed",
  rejections: 0,
  lastInstruction: null,
  spendUsd: 0,
  pendingApproval: false,
  sentInstruction: sentAtMs === null ? null : `fix ${threadId}`,
  sentAtMs,
});

it("lists the newest sent messages after the dismissal, at most three", () => {
  const threads = [
    thread("a", 10),
    thread("b", null),
    thread("c", 40),
    thread("d", 30),
    thread("e", 20),
    thread("f", 5),
  ];
  expect(recentSentMessages(threads, 0).map((sent) => sent.threadId)).toEqual(["c", "d", "e"]);
  expect(recentSentMessages(threads, 30).map((sent) => sent.threadId)).toEqual(["c"]);
  expect(recentSentMessages(threads, 40)).toEqual([]);
});
