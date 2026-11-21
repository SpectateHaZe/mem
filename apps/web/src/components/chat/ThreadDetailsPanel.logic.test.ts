import type { RuntimeSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isLiveSubagent,
  isUpcomingAutomation,
  splitEarlier,
  tightestUsageWindow,
} from "./ThreadDetailsPanel.logic";

const next = "2026-11-22T09:00:00.000Z";

describe("thread details panel", () => {
  it.each([
    { name: "repeating", enabled: true, nextRunAt: next, type: "interval", last: "succeeded" },
    { name: "webhook", enabled: true, nextRunAt: null, type: "webhook", last: "never" },
    { name: "running once", enabled: false, nextRunAt: null, type: "once", last: "running" },
  ] as const)("shows a $name automation", (row) => {
    const task = {
      enabled: row.enabled,
      nextRunAt: row.nextRunAt,
      schedule: { type: row.type },
      lastRunStatus: row.last,
    };
    expect(isUpcomingAutomation(task)).toBe(true);
  });

  it.each([
    { name: "finished one-time", enabled: true, nextRunAt: null, type: "once", last: "succeeded" },
    { name: "paused", enabled: false, nextRunAt: next, type: "interval", last: "failed" },
    { name: "paused webhook", enabled: false, nextRunAt: null, type: "webhook", last: "never" },
  ] as const)("keeps a $name automation behind Show earlier", (row) => {
    const task = {
      enabled: row.enabled,
      nextRunAt: row.nextRunAt,
      schedule: { type: row.type },
      lastRunStatus: row.last,
    };
    expect(isUpcomingAutomation(task)).toBe(false);
  });

  it("shows active subagents and keeps finished, failed and stopped ones earlier", () => {
    const statuses: RuntimeSubagentStatus[] = [
      "pending",
      "running",
      "waiting",
      "idle",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ];
    const { live, earlier } = splitEarlier(
      statuses.map((status) => ({ status })),
      isLiveSubagent,
    );
    expect(live.map((agent) => agent.status)).toEqual(["pending", "running", "waiting"]);
    expect(earlier.map((agent) => agent.status)).toEqual([
      "idle",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ]);
  });

  it("picks the most used window, and on a tie the one that resets last", () => {
    const window = (id: string, usedPercent: number, resetsAt?: string) =>
      ({
        id,
        kind: "other",
        label: id,
        usedPercent,
        ...(resetsAt ? { resetsAt } : {}),
      }) as ServerProviderUsageWindow;
    expect(tightestUsageWindow([])).toBeNull();
    expect(
      tightestUsageWindow([window("session", 13), window("weekly", 19), window("monthly", 5)])?.id,
    ).toBe("weekly");
    expect(
      tightestUsageWindow([
        window("session", 100, "2026-11-21T12:00:00.000Z"),
        window("weekly", 100, "2026-11-27T12:00:00.000Z"),
      ])?.id,
    ).toBe("weekly");
  });
});
