import type { GoalQueue } from "@t3tools/contracts";

type QueueAlert = {
  readonly type: "success" | "error" | "warning";
  readonly title: string;
  readonly description: string;
};

/** What changed worth telling someone who walked away. The first snapshot is history, not news. */
export function queueAlerts(previous: GoalQueue | undefined, next: GoalQueue) {
  if (previous === undefined) return [];
  const before = new Map(previous.goals.map((goal) => [goal.id, goal.status]));
  const alerts: QueueAlert[] = next.goals.flatMap((goal): QueueAlert[] => {
    const was = before.get(goal.id);
    if (was === undefined || was === goal.status) return [];
    if (goal.status === "done") {
      return [{ type: "success", title: "Queue goal finished", description: goal.text }];
    }
    if (goal.status === "failed") {
      return [{ type: "error", title: "Queue goal failed", description: goal.text }];
    }
    return [];
  });
  if (next.note !== undefined && next.note !== previous.note && next.note !== "Paused.") {
    alerts.push({ type: "warning", title: "Queue stopped", description: next.note });
  }
  return alerts;
}
