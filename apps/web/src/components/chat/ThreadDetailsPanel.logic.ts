import {
  isActiveSubagentStatus,
  type RuntimeSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { ScheduledTask, ServerProviderUsageWindow } from "@t3tools/contracts";

/** Live items lead a details section; the rest wait behind its Show earlier row. */
export function splitEarlier<Item>(items: readonly Item[], isLive: (item: Item) => boolean) {
  return { live: items.filter(isLive), earlier: items.filter((item) => !isLive(item)) };
}

/** Running now, or due again. A webhook has no next run, so being on is enough. */
export function isUpcomingAutomation(
  task: Pick<ScheduledTask, "enabled" | "nextRunAt" | "lastRunStatus"> & {
    readonly schedule: Pick<ScheduledTask["schedule"], "type">;
  },
) {
  return (
    task.lastRunStatus === "running" ||
    (task.enabled && (task.nextRunAt !== null || task.schedule.type === "webhook"))
  );
}

/** Idle counts as finished, like the row's own status line. */
export const isLiveSubagent = (agent: { readonly status: RuntimeSubagentStatus }) =>
  isActiveSubagentStatus(agent.status);

const resetTime = (window: ServerProviderUsageWindow) =>
  window.resetsAt === undefined ? 0 : Date.parse(window.resetsAt);

/** The window nearest its limit. On a tie the later reset wins, since it blocks work longer. */
export function tightestUsageWindow(windows: readonly ServerProviderUsageWindow[]) {
  let tightest: ServerProviderUsageWindow | null = null;
  for (const window of windows) {
    if (
      tightest === null ||
      window.usedPercent > tightest.usedPercent ||
      (window.usedPercent === tightest.usedPercent && resetTime(window) > resetTime(tightest))
    ) {
      tightest = window;
    }
  }
  return tightest;
}
