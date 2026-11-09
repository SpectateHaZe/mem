import {
  formatSubagentDisplayTitle,
  resolveSubagentMetadata,
} from "@t3tools/client-runtime/state/subagent-display";
import {
  deriveWorkflowGroups,
  projectedSubagentsToRuntime,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  latestSubagentTodoList,
  subagentPanelRow,
  subagentProgressLabel,
  subagentProgressPercent,
} from "@t3tools/client-runtime/state/subagent-panel";
import { EnvironmentId, OrchestrationV2RemoteTaskChild, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { BotIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useStableCallback } from "../../hooks/useStableCallback";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import { SectionHeaderStatus } from "../ui/collapsible-section-header";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

/** One row of the subagents panel: title, live to-do progress, one status line. */
function SubagentProgressRow(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: RuntimeSubagent;
  /** A task in a linked environment has no local thread; open it there when connected. */
  readonly remote: OrchestrationV2RemoteTaskChild | null;
  readonly onOpenThread: (childThreadId: ThreadId) => void;
  readonly onOpenRemote: (child: OrchestrationV2RemoteTaskChild) => void;
}) {
  const childRef =
    props.agent.childThreadId === null
      ? null
      : scopeThreadRef(props.environmentId, ThreadId.make(props.agent.childThreadId));
  const shell = useQuietThreadShell(childRef);
  const childStructure = useQuietThreadProjection(childRef);
  const remoteEnvironment = useEnvironment(props.remote?.environmentId ?? null);
  // The task's real to-do list lives in its own thread's plans.
  const plan = latestSubagentTodoList(childStructure?.projection.plans ?? null);
  const row = subagentPanelRow({
    agentStatus: props.agent.status,
    agentCompletedAt: props.agent.completedAt,
    childShell: shell,
    plan,
  });
  const progressLabel = subagentProgressLabel(row.progress);
  const percent = subagentProgressPercent(row.progress);
  const status = row.status;
  const finishedFailed = status?.kind === "finished" && status.outcome === "failed";
  const title = formatSubagentDisplayTitle(props.agent.title);
  const modelLabel =
    props.agent.model === null
      ? null
      : resolveSubagentMetadata({ model: props.agent.model }).modelLabel;
  const fillClass =
    status?.kind === "finished"
      ? status.outcome === "completed"
        ? "bg-success"
        : status.outcome === "failed"
          ? "bg-destructive"
          : "bg-muted-foreground/40"
      : "bg-info";
  const disabled =
    props.agent.childThreadId === null && (props.remote === null || remoteEnvironment === null);
  return (
    <li className="list-none">
      <ThreadDetailsControl
        part="row"
        multiline
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (disabled) return;
          if (props.agent.childThreadId === null) {
            if (props.remote !== null) props.onOpenRemote(props.remote);
            return;
          }
          props.onOpenThread(ThreadId.make(props.agent.childThreadId));
        }}
      >
        <span className="min-w-0 flex-1 text-left">
          <span className="flex min-w-0 items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-foreground/85">{title}</span>
            {modelLabel !== null ? (
              <span className="shrink-0 truncate text-2xs text-muted-foreground/80">
                {modelLabel}
              </span>
            ) : null}
          </span>
          {progressLabel !== null && percent !== null ? (
            <span className="mt-1 flex w-full items-center gap-2">
              <span
                role="progressbar"
                aria-label={`${title} task progress`}
                aria-valuenow={row.progress?.completed}
                aria-valuemin={0}
                aria-valuemax={row.progress?.total}
                className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted-foreground/15"
              >
                <span
                  aria-hidden
                  className={cn("block h-full rounded-full", fillClass)}
                  style={{ width: `${percent}%` }}
                />
              </span>
              <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                {progressLabel}
              </span>
            </span>
          ) : (
            <span className="mt-1 block text-2xs text-muted-foreground/60">No task list</span>
          )}
          {status !== null ? (
            <span
              className={cn(
                "mt-0.5 block truncate text-2xs",
                finishedFailed
                  ? "text-destructive"
                  : status.kind === "waiting_on_you"
                    ? "text-warning"
                    : "text-muted-foreground",
              )}
            >
              {status.text}
            </span>
          ) : null}
        </span>
      </ThreadDetailsControl>
    </li>
  );
}

/**
 * The thread's delegated subagents, each with progress from its real to-do list and one truthful
 * status line. Finished tasks stay listed; a thread without subagents renders nothing. Desktop
 * shows the same panel, since it wraps this web client.
 */
export function SubagentProgressPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const structure = useQuietThreadProjection(ref);
  const [expanded, setExpanded] = useState(true);
  const navigate = useNavigate();

  // Flats and workflow members list; the coordinators fall back in, so a workflow whose members
  // have not started still shows.
  const projected = structure?.projection.subagents ?? [];
  const runtimeSubagents = projectedSubagentsToRuntime(projected);
  const remoteByAgentId = new Map<string, OrchestrationV2RemoteTaskChild | null>(
    projected.map((agent) => [
      agent.id,
      agent.remoteChild === undefined ? null : agent.remoteChild,
    ]),
  );
  const groups = deriveWorkflowGroups(runtimeSubagents);
  const members = groups.flatMap((group) => [
    ...group.phases.flatMap((phase) => phase.members),
    ...group.unphasedMembers,
  ]);
  const singles = runtimeSubagents.filter((agent) => agent.kind === "subagent");
  const coordinators = runtimeSubagents.filter((agent) => agent.kind === "workflow");
  const rows = (members.length > 0 || singles.length > 0 ? [...singles, ...members] : coordinators)
    .slice()
    .sort(
      (first, second) =>
        first.firstSeenAt.localeCompare(second.firstSeenAt) || first.id.localeCompare(second.id),
    );
  const remoteForAgent = (agent: RuntimeSubagent) =>
    remoteByAgentId.get(agent.id) ??
    (agent.parentAgentId === null ? undefined : remoteByAgentId.get(agent.parentAgentId)) ??
    null;

  const openChild = useStableCallback((childThreadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(props.environmentId, ThreadId.make(childThreadId)),
      ),
    });
  });
  const openRemote = useStableCallback((child: OrchestrationV2RemoteTaskChild) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(child.environmentId, child.threadId)),
    });
  });

  if (rows.length === 0) return null;
  const failedCount = rows.filter(
    (agent) => agent.status === "failed" || agent.status === "cancelled",
  ).length;

  return (
    <ThreadDetailsSection
      headingId="thread-details-subagents-heading"
      title="Subagents"
      showHeading={false}
      data-subagents-progress-panel
    >
      <div>
        <ThreadDetailsControl aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <BotIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 flex-1 truncate")}>
            Subagents
          </span>
          {failedCount > 0 ? <SectionHeaderStatus>{failedCount} failed</SectionHeaderStatus> : null}
          {expanded ? null : (
            <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
              {rows.length}
            </span>
          )}
          <ChevronDownIcon
            aria-hidden
            className={cn(
              THREAD_DETAILS_PANEL_CHEVRON_CLASS,
              "transition-transform",
              !expanded && "-rotate-90",
            )}
          />
        </ThreadDetailsControl>
        {expanded ? (
          <ul
            aria-label="Subagents"
            className="m-0 max-h-64 list-none overflow-y-auto overscroll-contain p-0"
          >
            {rows.map((agent) => (
              <SubagentProgressRow
                key={agent.id}
                environmentId={props.environmentId}
                agent={agent}
                remote={remoteForAgent(agent)}
                onOpenThread={openChild}
                onOpenRemote={openRemote}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
