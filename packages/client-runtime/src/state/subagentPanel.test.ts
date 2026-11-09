import { RunId, type OrchestrationV2PlanArtifact } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  latestSubagentTodoList,
  refreshSubagentStatusFromShell,
  subagentPanelRow,
  subagentPlanProgress,
  subagentProgressLabel,
  subagentProgressPercent,
  subagentWaitingOnLabel,
  subagentWorkingOnLabel,
  type SubagentTodoList,
} from "./subagentPanel.ts";
import type { RuntimeSubagentStatus } from "./subagentRuntime.ts";

const plan = (steps: SubagentTodoList["steps"]): SubagentTodoList => ({
  kind: "todo_list",
  id: "plan:1" as SubagentTodoList["id"],
  threadId: "thread:1" as SubagentTodoList["threadId"],
  runId: null,
  nodeId: "node:1" as SubagentTodoList["nodeId"],
  status: "active",
  steps,
});

const step = (
  id: string,
  status: "pending" | "running" | "completed",
  text = `item ${id}`,
): SubagentTodoList["steps"][number] => ({ id, text, status });

const proposal = (status: OrchestrationV2PlanArtifact["status"] = "active") =>
  ({
    kind: "proposed_plan",
    id: "plan:2",
    threadId: "thread:1",
    runId: null,
    nodeId: "node:2",
    status,
    markdown: "# plan",
  }) as OrchestrationV2PlanArtifact;

describe("latestSubagentTodoList", () => {
  it("returns the newest list that no other plan superseded", () => {
    const first = plan([step("a", "completed")]);
    const second = plan([step("b", "pending")]);
    expect(latestSubagentTodoList([first, second])).toBe(second);
  });

  it("returns null when there is no todo list", () => {
    expect(latestSubagentTodoList(null)).toBeNull();
    expect(latestSubagentTodoList(undefined)).toBeNull();
    expect(latestSubagentTodoList([])).toBeNull();
    expect(latestSubagentTodoList([proposal()])).toBeNull();
  });

  it("walks past a superseded list to the one it replaced", () => {
    const first = plan([step("a", "completed")]);
    const superseded: SubagentTodoList = { ...plan([step("b", "pending")]), status: "superseded" };
    expect(latestSubagentTodoList([first, superseded])).toBe(first);
    expect(latestSubagentTodoList([superseded])).toBeNull();
  });

  it("keeps a completed list so a finished task still shows its final bar", () => {
    const completed = plan([step("a", "completed")]);
    const withStatus: OrchestrationV2PlanArtifact = { ...completed, status: "completed" };
    expect(latestSubagentTodoList([withStatus])).toBe(withStatus);
  });
});

describe("subagentPlanProgress", () => {
  it("counts completed items of the list", () => {
    expect(subagentPlanProgress(plan([step("a", "completed"), step("b", "completed")]))).toEqual({
      completed: 2,
      total: 2,
      currentStep: null,
    });
  });

  it("leaves running and pending items out of the count and names the running one", () => {
    expect(
      subagentPlanProgress(
        plan([step("a", "completed"), step("b", "running"), step("c", "pending")]),
      ),
    ).toEqual({ completed: 1, total: 3, currentStep: "item b" });
  });

  it("yields no progress for a missing or empty list", () => {
    expect(subagentPlanProgress(null)).toBeNull();
    expect(subagentPlanProgress(undefined)).toBeNull();
    expect(subagentPlanProgress(plan([]))).toBeNull();
  });
});

describe("subagentProgressLabel and percent", () => {
  it("formats completed of total", () => {
    const progress = subagentPlanProgress(
      plan([step("a", "completed"), step("b", "completed"), step("c", "pending")]),
    );
    expect(subagentProgressLabel(progress)).toBe("2 of 3");
    expect(subagentProgressPercent(progress)).toBe(67);
  });

  it("hides both when there is no list", () => {
    expect(subagentProgressLabel(null)).toBeNull();
    expect(subagentProgressPercent(null)).toBeNull();
  });
});

describe("subagentWorkingOnLabel", () => {
  it("collapses whitespace and passes short text through", () => {
    expect(subagentWorkingOnLabel("  Write  the   fix ")).toBe("Write the fix");
  });

  it("is null for blank text and truncates long text", () => {
    expect(subagentWorkingOnLabel(" \n\t ")).toBeNull();
    expect(subagentWorkingOnLabel("a".repeat(200))).toBe(`${"a".repeat(99)}…`);
  });
});

describe("subagentWaitingOnLabel", () => {
  it("names the awaited work from its description", () => {
    expect(
      subagentWaitingOnLabel([
        { kind: "command", taskId: "t1", description: "vp run dev", awaited: true },
      ]),
    ).toBe("vp run dev");
  });

  it("falls back to a kind label for a single awaited task", () => {
    expect(subagentWaitingOnLabel([{ kind: "command", taskId: "t1", awaited: true }])).toBe(
      "a background command",
    );
    expect(subagentWaitingOnLabel([{ kind: "subagent", taskId: "t1", awaited: true }])).toBe(
      "a child task",
    );
  });

  it("counts multiple awaited tasks without descriptions", () => {
    expect(
      subagentWaitingOnLabel([
        { kind: "command", taskId: "t1", awaited: true },
        { kind: "monitor", taskId: "t2", awaited: true },
      ]),
    ).toBe("2 tasks");
  });

  it("ignores work the agent did not declare it waits on", () => {
    expect(subagentWaitingOnLabel([{ kind: "command", taskId: "t1" }])).toBeNull();
    expect(subagentWaitingOnLabel(undefined)).toBeNull();
  });
});

describe("refreshSubagentStatusFromShell", () => {
  const quietShell = {
    runtime: null,
    latestRun: null,
    blockedOnThreadWait: false,
  };
  const followUpRun = {
    runId: RunId.make("run-2"),
    status: "running" as const,
    requestedAt: "2026-01-01T01:00:00.000Z",
    startedAt: "2026-01-01T01:00:00.000Z",
    completedAt: null,
  };

  it("lets an active task record stand", () => {
    expect(
      refreshSubagentStatusFromShell({
        agentStatus: "running",
        agentCompletedAt: null,
        shell: { ...quietShell, runtime: { status: "running" } },
      }),
    ).toBe("running");
  });

  it("stays finished while the child runs nothing again", () => {
    expect(
      refreshSubagentStatusFromShell({
        agentStatus: "completed",
        agentCompletedAt: "2026-01-01T00:00:00.000Z",
        shell: quietShell,
      }),
    ).toBe("completed");
  });

  it("marks a newer follow-up run as pending when the runtime has not caught up", () => {
    expect(
      refreshSubagentStatusFromShell({
        agentStatus: "completed",
        agentCompletedAt: "2026-01-01T00:00:00.000Z",
        shell: { ...quietShell, latestRun: followUpRun },
      }),
    ).toBe("pending");
  });
});

type ShellSignals = {
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly blockedOnThreadWait?: boolean | undefined;
  readonly pendingBackgroundTasks?: ReadonlyArray<
    import("@t3tools/contracts").OrchestrationV2PendingBackgroundTask
  >;
};

const signalStatus = (
  status: RuntimeSubagentStatus,
  shell: ShellSignals | null,
  planSteps: SubagentTodoList | null = null,
) =>
  subagentPanelRow({
    agentStatus: status,
    agentCompletedAt: null,
    childShell: shell,
    plan: planSteps,
  });

describe("subagentStatusLine", () => {
  it.each([
    ["completed", "Finished"],
    ["failed", "Finished · Failed"],
    ["cancelled", "Finished · Stopped"],
    ["interrupted", "Finished · Stopped"],
    ["idle", "Finished · Idle"],
  ] as ReadonlyArray<readonly [RuntimeSubagentStatus, string]>)(
    "maps terminal %s to its finished-variant label",
    (status, text) => {
      const row = signalStatus(status, null);
      expect(row.status?.kind).toBe("finished");
      expect(row.status?.text).toBe(text);
    },
  );

  it("names the running plan item", () => {
    const row = signalStatus("running", null, plan([step("a", "completed"), step("b", "running")]));
    expect(row.status).toEqual({
      kind: "working",
      text: "Working on: item b",
      outcome: null,
    });
    expect(subagentProgressLabel(row.progress)).toBe("1 of 2");
  });

  it("keeps Working when a listless worker keeps going", () => {
    expect(signalStatus("running", null).status).toEqual({
      kind: "working",
      text: "Working",
      outcome: null,
    });
  });

  it("reports a pending approval or question as Waiting on you", () => {
    expect(signalStatus("running", { hasPendingApprovals: true }).status?.text).toBe(
      "Waiting on you",
    );
    expect(signalStatus("running", { hasPendingUserInput: true }).status?.text).toBe(
      "Waiting on you",
    );
  });

  it("reports the awaited install, test run or child task it holds on", () => {
    expect(
      signalStatus("running", {
        pendingBackgroundTasks: [
          { kind: "command", taskId: "t", description: "npm ci", awaited: true },
        ],
      }).status?.text,
    ).toBe("Waiting on: npm ci");
    expect(signalStatus("running", { blockedOnThreadWait: true }).status?.text).toBe(
      "Waiting on: a child task",
    );
    expect(signalStatus("running", { blockedOnThreadWait: false }).status?.text).toBe("Working");
  });

  it("maps an untouched queued task to the queue", () => {
    expect(signalStatus("pending", null).status).toEqual({
      kind: "waiting_on",
      text: "Waiting on: the queue",
      outcome: null,
    });
  });

  it("prefers Waiting on you over other waits", () => {
    expect(
      signalStatus("running", {
        hasPendingUserInput: true,
        pendingBackgroundTasks: [{ kind: "command", taskId: "t", awaited: true }],
      }).status?.text,
    ).toBe("Waiting on you");
  });

  it("never shows a working line for a task that ended, whatever the child still reports", () => {
    const finished = signalStatus("failed", {
      hasPendingApprovals: false,
      pendingBackgroundTasks: [
        { kind: "command", taskId: "t", description: "npm ci", awaited: true },
      ],
    });
    expect(finished.status).toEqual({
      kind: "finished",
      text: "Finished · Failed",
      outcome: "failed",
    });
  });

  it("reports no line for an unknown status", () => {
    expect(signalStatus("rolled_back" as unknown as RuntimeSubagentStatus, null).status).toBeNull();
  });
});
