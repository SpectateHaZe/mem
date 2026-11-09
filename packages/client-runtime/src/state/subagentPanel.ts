import type { OrchestrationV2PlanArtifact } from "@t3tools/contracts";
import type { ThreadRuntimeSummary, ThreadRunSummary } from "./models.ts";
import { isTerminalSubagentStatus, type RuntimeSubagentStatus } from "./subagentRuntime.ts";

export type SubagentTodoList = Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }>;

export interface SubagentPlanProgress {
  readonly completed: number;
  readonly total: number;
  readonly currentStep: string | null;
}

/**
 * The thread's working list: the newest todo_list the thread has not superseded. A thread that
 * replaced its list marks the old one superseded, so the search walks back from the newest to
 * whichever list is still live.
 */
export function latestSubagentTodoList(
  plans: ReadonlyArray<OrchestrationV2PlanArtifact> | null | undefined,
): SubagentTodoList | null {
  if (plans === null || plans === undefined) return null;
  for (let index = plans.length - 1; index >= 0; index -= 1) {
    const plan = plans[index];
    if (plan?.kind === "todo_list" && plan.status !== "superseded") return plan;
  }
  return null;
}

/**
 * Progress from a real to-do list only: completed items of the list's items. A list with no items
 * is no list, so it yields null and the caller shows no bar.
 */
export function subagentPlanProgress(
  plan: SubagentTodoList | null | undefined,
): SubagentPlanProgress | null {
  if (plan === null || plan === undefined || plan.steps.length === 0) return null;
  let completed = 0;
  let currentStep: string | null = null;
  for (const step of plan.steps) {
    if (step.status === "completed") completed += 1;
    else if (currentStep === null && step.status === "running") currentStep = step.text;
  }
  return { completed, total: plan.steps.length, currentStep };
}

/** "3 of 7", or null when there is no list to count. */
export function subagentProgressLabel(
  progress: SubagentPlanProgress | null | undefined,
): string | null {
  return progress === null || progress === undefined
    ? null
    : `${progress.completed} of ${progress.total}`;
}

export function subagentProgressPercent(
  progress: SubagentPlanProgress | null | undefined,
): number | null {
  if (progress === null || progress === undefined || progress.total === 0) return null;
  return Math.round((progress.completed / progress.total) * 100);
}

const LABEL_LIMIT = 100;

function truncateLabel(text: string): string {
  if (text.length <= LABEL_LIMIT) return text;
  let end = LABEL_LIMIT - 1;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return `${text.slice(0, end)}…`;
}

function cleanLabel(text: string): string {
  const cleaned = text.replace(/\s+/gu, " ").trim();
  return cleaned.length === 0 ? "" : truncateLabel(cleaned);
}

/** The current plan item as a one-line label, when one is in progress. */
export function subagentWorkingOnLabel(currentStep: string | null | undefined): string | null {
  if (currentStep === null || currentStep === undefined) return null;
  const label = cleanLabel(currentStep);
  return label.length === 0 ? null : label;
}

const BACKGROUND_TASK_KIND_LABELS: Readonly<Record<string, string>> = {
  subagent: "a child task",
  command: "a background command",
  monitor: "a monitored task",
  background_task: "a background task",
};

/** The fields of a pending roster entry this module reads; shells carry the full entry type. */
export interface SubagentPendingWorkTask {
  readonly kind: string;
  readonly taskId: string;
  readonly description?: string | undefined;
  readonly awaited?: true | undefined;
}

/** The work the agent declared it waits on, as a "Waiting on" label. */
export function subagentWaitingOnLabel(
  tasks: ReadonlyArray<SubagentPendingWorkTask> | null | undefined,
): string | null {
  const awaited = tasks?.filter((task) => task.awaited === true) ?? [];
  if (awaited.length === 0) return null;
  for (const task of awaited) {
    const description = task.description === undefined ? "" : cleanLabel(task.description);
    if (description.length > 0) return description;
  }
  if (awaited.length > 1) return `${awaited.length} tasks`;
  const first = awaited[0];
  return first === undefined
    ? null
    : (BACKGROUND_TASK_KIND_LABELS[first.kind] ?? "a background task");
}

/** What makes a working subagent stop for the user or other work, from its own thread's shell. */
export interface SubagentWaitSignals {
  readonly waitingOnYou: boolean;
  readonly waitingOn: string | null;
}

export interface SubagentWaitSignalsInput {
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly blockedOnThreadWait?: boolean | undefined;
  readonly pendingBackgroundTasks?: ReadonlyArray<SubagentPendingWorkTask> | undefined;
}

function subagentWaitSignals(
  input: SubagentWaitSignalsInput | null | undefined,
): SubagentWaitSignals {
  if (input === null || input === undefined) return { waitingOnYou: false, waitingOn: null };
  const label = subagentWaitingOnLabel(input.pendingBackgroundTasks);
  return {
    waitingOnYou: input.hasPendingApprovals === true || input.hasPendingUserInput === true,
    waitingOn: label ?? (input.blockedOnThreadWait === true ? "a child task" : null),
  };
}

const LIVE_SHELL_RUN_STATUSES: ReadonlySet<ThreadRuntimeSummary["status"]> = new Set([
  "preparing",
  "starting",
  "queued",
  "running",
  "waiting",
]);

const SHELL_RUN_STATUS_TO_AGENT: ReadonlyMap<string, RuntimeSubagentStatus> = new Map([
  ["preparing", "pending"],
  ["starting", "pending"],
  ["queued", "pending"],
  ["running", "running"],
  ["waiting", "waiting"],
]);

/**
 * The fields of a thread's shell and its latest run that refreshSubagentStatusFromShell reads;
 * the full shell carries the rest. The task record decides while it is still active. A terminal
 * record on a child thread with a live run means the work started again — the same child thread
 * runs follow-up tasks — so the shell's live status revives the row.
 */
export interface SubagentRunShellInput {
  readonly runtime?: Pick<ThreadRuntimeSummary, "status"> | null | undefined;
  readonly latestRun?:
    | Pick<ThreadRunSummary, "runId" | "requestedAt" | "startedAt" | "completedAt">
    | null
    | undefined;
  readonly blockedOnThreadWait?: boolean | undefined;
}

export function refreshSubagentStatusFromShell(input: {
  readonly agentStatus: RuntimeSubagentStatus;
  readonly agentCompletedAt: string | null;
  readonly shell: SubagentRunShellInput | null | undefined;
}): RuntimeSubagentStatus {
  const shell = input.shell;
  if (shell === null || shell === undefined) return input.agentStatus;
  if (isTerminalSubagentStatus(input.agentStatus)) {
    const runtimeStatus = shell.runtime?.status ?? null;
    if (
      runtimeStatus !== null &&
      LIVE_SHELL_RUN_STATUSES.has(runtimeStatus) &&
      shell.blockedOnThreadWait !== true
    ) {
      return SHELL_RUN_STATUS_TO_AGENT.get(runtimeStatus) ?? input.agentStatus;
    }
    const newestRun = shell.latestRun;
    if (
      newestRun !== null &&
      newestRun !== undefined &&
      newestRun.completedAt === null &&
      input.agentCompletedAt !== null &&
      newestRun.startedAt !== null &&
      Date.parse(newestRun.startedAt) > Date.parse(input.agentCompletedAt)
    ) {
      return "pending";
    }
    return input.agentStatus;
  }
  return input.agentStatus;
}

/**
 * Exactly one line, in the task's own words or a truthful fallback: "Working on: <what>",
 * "Waiting on you", "Waiting on: <what>", or "Finished" — with failed, cancelled and idle still
 * finished-variants so success reads apart from them.
 */
export interface SubagentPanelStatus {
  readonly kind: "working" | "waiting_on_you" | "waiting_on" | "finished";
  readonly text: string;
  readonly outcome: "completed" | "failed" | "stopped" | "idle" | null;
}

export interface SubagentStatusLineInput {
  readonly status: RuntimeSubagentStatus;
  readonly waitingOnYou: boolean;
  readonly waitingOn: string | null;
  readonly workingOn: string | null;
}

function subagentStatusLine(input: SubagentStatusLineInput): SubagentPanelStatus | null {
  const { status } = input;
  if (isTerminalSubagentStatus(status) || status === "idle") {
    const outcome =
      status === "completed"
        ? "completed"
        : status === "failed"
          ? "failed"
          : status === "idle"
            ? "idle"
            : "stopped";
    return {
      kind: "finished",
      text:
        outcome === "completed"
          ? "Finished"
          : outcome === "failed"
            ? "Finished · Failed"
            : outcome === "idle"
              ? "Finished · Idle"
              : "Finished · Stopped",
      outcome,
    };
  }
  // A question or approval pending on the agent's own run always reads first.
  if (input.waitingOnYou) return { kind: "waiting_on_you", text: "Waiting on you", outcome: null };
  if (input.waitingOn !== null) {
    return { kind: "waiting_on", text: `Waiting on: ${input.waitingOn}`, outcome: null };
  }
  if (status === "pending")
    return { kind: "waiting_on", text: "Waiting on: the queue", outcome: null };
  if (status === "running" || status === "waiting") {
    return {
      kind: "working",
      text: input.workingOn !== null ? `Working on: ${input.workingOn}` : "Working",
      outcome: null,
    };
  }
  return null;
}

/** One subagents-panel row: progress off the child's real to-do list, status off its own state. */
export function subagentPanelRow(input: {
  readonly agentStatus: RuntimeSubagentStatus;
  readonly agentCompletedAt: string | null;
  readonly childShell: SubagentWaitSignalsInput | null | undefined;
  readonly plan: SubagentTodoList | null | undefined;
}): {
  readonly progress: SubagentPlanProgress | null;
  readonly status: SubagentPanelStatus | null;
} {
  const progress = subagentPlanProgress(input.plan);
  const signals = subagentWaitSignals(input.childShell);
  return {
    progress,
    status: subagentStatusLine({
      status: refreshSubagentStatusFromShell({
        agentStatus: input.agentStatus,
        agentCompletedAt: input.agentCompletedAt,
        shell: input.childShell,
      }),
      waitingOnYou: signals.waitingOnYou,
      waitingOn: signals.waitingOn,
      workingOn: subagentWorkingOnLabel(progress?.currentStep ?? null),
    }),
  };
}
