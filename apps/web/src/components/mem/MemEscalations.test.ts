import type { MemWatchedThread } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { recentEscalations, RECENT_ESCALATION_MS } from "./MemEscalations";

const NOW = new Date(2026, 10, 21, 12, 0).getTime();

const watched = (overrides: Partial<MemWatchedThread>): MemWatchedThread => ({
  threadId: "t",
  phase: "escalated",
  rejections: 1,
  lastInstruction: null,
  spendUsd: 0,
  pendingApproval: false,
  sentInstruction: null,
  sentAtMs: null,
  updatedAtMs: NOW - 60_000,
  priority: "normal",
  waitingUntilMs: null,
  waitingFor: null,
  roundSummaries: [],
  ...overrides,
});

it("lists the most-rejected recent escalations first and caps the banner", () => {
  const listed = recentEscalations(
    [
      watched({ threadId: "a", rejections: 2 }),
      watched({ threadId: "b", phase: "claimed", rejections: 9 }),
      watched({ threadId: "c", rejections: 4 }),
      watched({ threadId: "d", rejections: 1 }),
      watched({ threadId: "e", rejections: 3 }),
    ],
    NOW,
  );
  expect(listed.map((thread) => thread.threadId)).toEqual(["c", "e", "a"]);
});

it("lets an old escalation age out instead of nagging about a finished night", () => {
  const listed = recentEscalations(
    [
      watched({ threadId: "stale", updatedAtMs: NOW - RECENT_ESCALATION_MS - 1 }),
      watched({ threadId: "fresh", updatedAtMs: NOW - RECENT_ESCALATION_MS + 1 }),
    ],
    NOW,
  );
  expect(listed.map((thread) => thread.threadId)).toEqual(["fresh"]);
});

it("shows a record from an older server that has no timestamp", () => {
  const listed = recentEscalations([watched({ threadId: "legacy", updatedAtMs: 0 })], NOW);
  expect(listed.map((thread) => thread.threadId)).toEqual(["legacy"]);
});

it("keeps a dismissed entry hidden until that thread escalates again", () => {
  const entry = watched({ threadId: "a", updatedAtMs: NOW - 1_000 });
  expect(recentEscalations([entry], NOW, [`a:${entry.updatedAtMs}`])).toEqual([]);
  // A new escalation has a new record timestamp, so the old dismissal does not swallow it.
  expect(
    recentEscalations([watched({ threadId: "a", updatedAtMs: NOW - 500 })], NOW, [
      `a:${entry.updatedAtMs}`,
    ]),
  ).toHaveLength(1);
});
