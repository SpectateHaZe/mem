import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import {
  creditFallbackRetryNote,
  isCreditExhaustionFailure,
  isCreditFallbackRetryPrompt,
} from "../mcp/delegatedTaskCredit.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "../mcp/delegatedTaskModes.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

export class DelegatedTaskCreditReactor extends Context.Service<
  DelegatedTaskCreditReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/DelegatedTaskCreditReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providerCatalog = yield* ProviderRegistry.ProviderRegistry;

  const skipLog = (reason: string, task: OrchestrationV2Subagent) =>
    Effect.logWarning("delegated-task-credit-fallback-skipped", {
      reason,
      taskId: task.id,
      parentThreadId: task.threadId,
    });

  const retryTask = Effect.fn("DelegatedTaskCreditReactor.retryTask")(function* (
    task: OrchestrationV2Subagent,
  ) {
    const failedSelection = task.modelSelection;
    const childThreadId = task.childThreadId;
    const parentRunId = task.runId;
    if (failedSelection === undefined || parentRunId === null || childThreadId === null) {
      yield* skipLog("task-has-no-completed-structure", task);
      return;
    }
    const configured = yield* settings.getSettings.pipe(
      Effect.map((rows) => rows.subagentFallbackModelSelection),
      Effect.orElseSucceed(() => null),
    );
    if (configured === null) {
      yield* skipLog("no-fallback-configured", task);
      return;
    }
    if (
      configured.instanceId === failedSelection.instanceId &&
      configured.model === failedSelection.model
    ) {
      yield* skipLog("fallback-is-failed-model", task);
      return;
    }
    const parent = yield* projections
      .getThreadRecords(task.threadId, [])
      .pipe(Effect.orElseSucceed(() => undefined));
    const child = yield* projections
      .getThreadRecords(childThreadId, [])
      .pipe(Effect.orElseSucceed(() => undefined));
    if (
      parent === undefined ||
      child === undefined ||
      parent.thread.archivedAt !== null ||
      parent.thread.deletedAt !== null ||
      child.thread.deletedAt !== null
    ) {
      yield* skipLog("thread-unavailable", task);
      return;
    }
    const provider = yield* providerCatalog.getProviders.pipe(
      Effect.map((entries) => entries.find((entry) => entry.instanceId === configured.instanceId)),
      Effect.orElseSucceed(() => undefined),
    );
    if (provider === undefined) {
      yield* skipLog("unknown-provider-instance", task);
      return;
    }
    if (
      provider.models.length > 0 &&
      !provider.models.some((entry) => entry.slug === configured.model)
    ) {
      yield* skipLog("unknown-provider-model", task);
      return;
    }
    const fallbackModelSelection = {
      instanceId: configured.instanceId,
      model: configured.model,
      ...(configured.options === undefined ? {} : { options: configured.options }),
    } as const;
    const modes = yield* Effect.all([
      resolveRuntimeMode(
        parent.thread.runtimeMode,
        // The mode the failed child actually ran with; an unsupported one steps
        // down to the broadest mode the fallback target still offers.
        child.thread.runtimeMode,
        {
          modelSelection: fallbackModelSelection,
          supportedRuntimeModes: provider.supportedRuntimeModes,
        },
      ),
      resolveInteractionMode(parent.thread.interactionMode, child.thread.interactionMode),
    ]).pipe(Effect.result);
    if (Result.isFailure(modes)) {
      yield* Effect.logWarning("delegated-task-credit-fallback-skipped", {
        reason: "mode-resolution",
        taskId: task.id,
        parentThreadId: task.threadId,
        cause: modes.failure,
      });
      return;
    }
    const [retryRuntimeMode, interactionMode] = modes.success;
    const childWorktreePath = child.thread.worktreePath;
    const retryWorkspaceStrategy =
      childWorktreePath !== null && childWorktreePath !== parent.thread.worktreePath
        ? { type: "existing_worktree" as const, worktreePath: childWorktreePath }
        : undefined;
    const retryCommandId = CommandId.make(`server:delegated-task-credit-fallback:${task.id}`);
    if (yield* threads.hasReceipt(retryCommandId)) {
      yield* skipLog("already-retried", task);
      return;
    }
    const retryResult = yield* threads.dispatch({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "server",
      commandId: retryCommandId,
      parentThreadId: task.threadId,
      parentRunId,
      parentNodeId: task.parentNodeId,
      task: `${task.prompt}\n\n${creditFallbackRetryNote({
        providerInstanceId: failedSelection.instanceId,
        model: failedSelection.model,
      })}`,
      // The parent's wake message labels the retry with its title, so the
      // agent reads there which model the automatic fallback used.
      title: `${task.title ?? "Delegated task"} (credit fallback on ${configured.instanceId}/${configured.model})`,
      modelSelection: fallbackModelSelection,
      runtimeMode: retryRuntimeMode,
      interactionMode,
      ...(retryWorkspaceStrategy === undefined
        ? {}
        : { workspaceStrategy: retryWorkspaceStrategy }),
      completionWake: "always",
    });
    const retryTaskEvent = retryResult.storedEvents.find(
      (stored) =>
        stored.event.type === "subagent.updated" &&
        stored.event.payload.origin === "app_owned" &&
        stored.event.payload.id !== task.id,
    );
    if (retryTaskEvent === undefined || retryTaskEvent.event.type !== "subagent.updated") return;
    const retryChildThreadId = retryTaskEvent.event.payload.childThreadId;
    const retryRunEvent = retryResult.storedEvents.find(
      (stored) =>
        stored.event.type === "run.created" && stored.event.threadId === retryChildThreadId,
    );
    if (
      retryChildThreadId !== null &&
      retryRunEvent?.event.type === "run.created" &&
      retryRunEvent.event.payload.workspacePreparation !== undefined
    ) {
      yield* threadLaunch.prepareRun({
        commandId: retryCommandId,
        threadId: retryChildThreadId,
        runId: retryRunEvent.event.payload.id,
      });
    }
    yield* Effect.logInfo("delegated-task-credit-fallback", {
      taskId: task.id,
      retryTaskId: retryTaskEvent.event.payload.id,
      parentThreadId: task.threadId,
      instanceId: configured.instanceId,
      model: configured.model,
    });
  });

  // `settled_only` tasks deliver through the blocking delegateTask call, which
  // runs its own fallback; `always` tasks are the fire-and-forget ones here.
  const filterTask = (event: OrchestrationV2DomainEvent): OrchestrationV2Subagent | undefined => {
    if (event.type !== "subagent.updated") return undefined;
    const task = event.payload;
    if (
      task.origin !== "app_owned" ||
      task.status !== "failed" ||
      task.result === null ||
      task.runId === null ||
      task.childThreadId === null ||
      task.completionWake !== "always" ||
      (task.completionDelivery !== undefined && task.completionDelivery.state !== "pending") ||
      isCreditFallbackRetryPrompt(task.prompt) ||
      !isCreditExhaustionFailure(task.result)
    ) {
      return undefined;
    }
    return task;
  };

  const handle: DelegatedTaskCreditReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      const task = filterTask(event);
      if (task === undefined) return;
      yield* retryTask(task).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated-task-credit-fallback-failed", {
            taskId: task.id,
            parentThreadId: task.threadId,
            cause,
          }),
        ),
      );
    },
  );

  const start: DelegatedTaskCreditReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task credit fallback event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies DelegatedTaskCreditReactor["Service"];
});

export const layer = Layer.effect(DelegatedTaskCreditReactor, make);
