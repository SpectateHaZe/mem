import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { creditFallbackRetryNote } from "../mcp/delegatedTaskCredit.ts";
import * as DelegatedTaskCreditReactor from "./DelegatedTaskCreditReactor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

const driver = ProviderDriverKind.make("codex");
const primaryInstanceId = ProviderInstanceId.make("codex-primary");
const fallbackInstanceId = ProviderInstanceId.make("codex-fallback");
const primaryModel = "gpt-5.4";
const fallbackModel = "gpt-5.4-fallback";
const primarySelection = { instanceId: primaryInstanceId, model: primaryModel };
const fallbackSelection = { instanceId: fallbackInstanceId, model: fallbackModel };
const projectId = ProjectId.make("project:credit");
const parentThreadId = ThreadId.make("thread:credit-parent");
const parentRunId = RunId.make("run:credit-parent");
const parentNodeId = NodeId.make("node:credit-task");
const childThreadId = ThreadId.make("thread:credit-child");
const taskId = NodeId.make("node:credit-failed-task");
const retryCommandId = CommandId.make(`server:delegated-task-credit-fallback:${taskId}`);
const now = DateTime.makeUnsafe(0);
const creditFailureMessage = "Insufficient Balance (request_id: req_123)";
const worktreePath = "worktrees/credit-child";

const providerSnapshot = (input: {
  readonly instanceId: ProviderInstanceId;
  readonly model?: string;
}): ServerProvider =>
  ({
    instanceId: input.instanceId,
    driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-13T00:00:00.000Z",
    models:
      input.model === undefined
        ? []
        : [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  }) as unknown as ServerProvider;

type ThreadRecordOverride = { readonly worktreePath: string | null };
const projection = (input: { readonly id: ThreadId } & ThreadRecordOverride) =>
  ({
    thread: {
      id: input.id,
      projectId,
      title: "Credit parent",
      createdBy: "user",
      creationSource: "web",
      modelSelection: primarySelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      worktreePath: input.worktreePath,
      archivedAt: null,
      deletedAt: null,
    },
  }) as never;

const taskRow = (overrides: Partial<OrchestrationV2Subagent> = {}): OrchestrationV2Subagent =>
  ({
    id: taskId,
    threadId: parentThreadId,
    runId: parentRunId,
    parentNodeId,
    origin: "app_owned",
    createdBy: "agent",
    driver,
    providerInstanceId: primaryInstanceId,
    providerThreadId: null,
    childThreadId,
    nativeTaskRef: null,
    prompt: "Review the uncommitted changes.",
    title: "Review",
    model: primaryModel,
    modelSelection: primarySelection,
    completionWake: "always",
    completionDelivery: { state: "pending", observedByRunId: null },
    status: "failed",
    result: creditFailureMessage,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    ...overrides,
  }) as unknown as OrchestrationV2Subagent;

const terminalEvent = (task: OrchestrationV2Subagent): OrchestrationV2DomainEvent =>
  ({
    id: EventId.make(`event:terminal:${String(task.id)}`),
    type: "subagent.updated",
    threadId: task.threadId,
    runId: task.runId,
    nodeId: task.id,
    driver: task.driver,
    providerInstanceId: task.providerInstanceId,
    occurredAt: now,
    payload: task,
  }) as unknown as OrchestrationV2DomainEvent;

const harness = (options: {
  /** Defaults to the configured fallback model; null omits the setting. */
  readonly fallback?: ModelSelection | null;
  readonly childWorktreePath?: string | null;
  readonly dispatchFails?: boolean;
  readonly hasReceipt?: boolean;
}) => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const preparedRuns: Array<{ readonly commandId: CommandId; readonly runId: RunId }> = [];
  const receipts = new Set<string>();
  if (options.hasReceipt === true) receipts.add(retryCommandId);
  const providers = [
    providerSnapshot({ instanceId: primaryInstanceId, model: primaryModel }),
    providerSnapshot({ instanceId: fallbackInstanceId, model: fallbackModel }),
  ];
  const layer = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      hasReceipt: (commandId) => Effect.sync(() => receipts.has(commandId)),
      dispatch: (command) =>
        options.dispatchFails === true
          ? Effect.fail(
              new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                projectId,
                instanceId: fallbackInstanceId,
              }),
            )
          : Effect.sync(() => {
              receipts.add(command.commandId);
              dispatched.push(command);
              const index = dispatched.length;
              const retryChildId = ThreadId.make(`thread:credit-retry-${index}`);
              const workspaceStrategy =
                command.type === "delegated_task.request" ? command.workspaceStrategy : undefined;
              return {
                sequence: index,
                storedEvents: [
                  {
                    id: EventId.make(`event:retry-task:${index}`),
                    sequence: index,
                    commandId: command.commandId,
                    event: {
                      id: EventId.make(`event:retry-task:${index}`),
                      type: "subagent.updated",
                      threadId: parentThreadId,
                      runId: parentRunId,
                      nodeId: NodeId.make(`node:credit-retry-${index}`),
                      driver,
                      providerInstanceId: fallbackInstanceId,
                      occurredAt: now,
                      payload: {
                        id: NodeId.make(`node:credit-retry-${index}`),
                        threadId: parentThreadId,
                        runId: parentRunId,
                        parentNodeId,
                        origin: "app_owned",
                        createdBy: "agent",
                        driver,
                        providerInstanceId: fallbackInstanceId,
                        providerThreadId: null,
                        childThreadId: retryChildId,
                        nativeTaskRef: null,
                        prompt: "retry",
                        title: null,
                        model: fallbackModel,
                        modelSelection: fallbackSelection,
                        completionWake: "always",
                        status: "idle",
                        result: null,
                        startedAt: null,
                        completedAt: null,
                        updatedAt: now,
                      },
                    },
                  },
                  {
                    id: EventId.make(`event:retry-run:${index}`),
                    sequence: index,
                    commandId: command.commandId,
                    event: {
                      id: EventId.make(`event:retry-run:${index}`),
                      type: "run.created",
                      threadId: retryChildId,
                      payload: {
                        id: RunId.make(`run:credit-retry-${index}`),
                        threadId: retryChildId,
                        ordinal: 1,
                        providerInstanceId: fallbackInstanceId,
                        modelSelection: fallbackSelection,
                        status: "preparing",
                        userMessageId: MessageId.make(`message:credit-retry-${index}`),
                        rootNodeId: NodeId.make(`node:credit-retry-${index}`),
                        activeAttemptId: null,
                        requestedAt: now,
                        startedAt: now,
                        completedAt: null,
                        checkpointId: null,
                        contextHandoffId: null,
                        workspacePreparation: workspaceStrategy,
                      },
                    },
                  },
                ],
              } as never;
            }),
    }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      prepareRun: (input) =>
        Effect.sync(() => {
          preparedRuns.push({ commandId: input.commandId, runId: input.runId });
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: <K extends ProjectionStore.ProjectionRecordField>(
        threadId: ThreadId,
        _fields: ReadonlyArray<K>,
      ) =>
        Effect.succeed(
          projection({
            id: threadId,
            worktreePath: threadId === parentThreadId ? null : (options.childWorktreePath ?? null),
          }) as ProjectionStore.ProjectionRecords<K>,
        ),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
    }),
    ServerSettings.layerTest({
      subagentFallbackModelSelection:
        options.fallback === undefined ? fallbackSelection : options.fallback,
    }),
  );
  const composed = DelegatedTaskCreditReactor.layer.pipe(Layer.provide(layer));
  return { layer: composed, dispatched, preparedRuns, receipts } as const;
};

describe("DelegatedTaskCreditReactor", () => {
  it.effect("retries an out-of-credit task on the configured fallback model", () =>
    Effect.gen(function* () {
      const { layer, dispatched, preparedRuns } = harness({});
      yield* Effect.gen(function* () {
        const reactor = yield* DelegatedTaskCreditReactor.DelegatedTaskCreditReactor;
        yield* reactor.handle(terminalEvent(taskRow()));
        assert.equal(dispatched.length, 1);
        const request = dispatched[0];
        assert.equal(request?.type, "delegated_task.request");
        if (request?.type !== "delegated_task.request") return;
        assert.equal(request.parentThreadId, parentThreadId);
        assert.equal(request.parentRunId, parentRunId);
        assert.equal(request.parentNodeId, parentNodeId);
        assert.deepEqual(request.modelSelection, fallbackSelection);
        assert.equal(request.completionWake, "always");
        assert.include(
          request.task,
          `The previous attempt on ${primaryInstanceId} (${primaryModel}) ran out of credit before it finished.`,
        );
        assert.include(request.task, "Review the uncommitted changes.");
        assert.equal(
          request.title,
          `Review (credit fallback on ${fallbackInstanceId}/${fallbackModel})`,
        );
        assert.equal("workspaceStrategy" in request, false);
        assert.equal(preparedRuns.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("a replayed terminal event starts no second retry", () =>
    Effect.gen(function* () {
      const { layer, dispatched } = harness({});
      yield* Effect.gen(function* () {
        const reactor = yield* DelegatedTaskCreditReactor.DelegatedTaskCreditReactor;
        yield* reactor.handle(terminalEvent(taskRow()));
        yield* reactor.handle(terminalEvent(taskRow()));
        assert.equal(dispatched.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("a provider-disabled retry dispatch is swallowed", () =>
    Effect.gen(function* () {
      const { layer, dispatched } = harness({ dispatchFails: true });
      yield* Effect.gen(function* () {
        const reactor = yield* DelegatedTaskCreditReactor.DelegatedTaskCreditReactor;
        yield* reactor.handle(terminalEvent(taskRow()));
        assert.equal(dispatched.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("a retry of a retry does not start a second fallback", () =>
    Effect.gen(function* () {
      const { layer, dispatched } = harness({});
      yield* Effect.gen(function* () {
        const reactor = yield* DelegatedTaskCreditReactor.DelegatedTaskCreditReactor;
        yield* reactor.handle(
          terminalEvent(
            taskRow({
              prompt: `Retry the review.\n\n${creditFallbackRetryNote({
                providerInstanceId: primaryInstanceId,
                model: primaryModel,
              })}`,
            }),
          ),
        );
        assert.equal(dispatched.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("an isolated retry keeps working in the child's existing worktree", () =>
    Effect.gen(function* () {
      const { layer, dispatched, preparedRuns } = harness({ childWorktreePath: worktreePath });
      yield* Effect.gen(function* () {
        const reactor = yield* DelegatedTaskCreditReactor.DelegatedTaskCreditReactor;
        yield* reactor.handle(terminalEvent(taskRow()));
        assert.equal(dispatched.length, 1);
        const request = dispatched[0];
        assert.equal(request?.type, "delegated_task.request");
        if (request?.type !== "delegated_task.request") return;
        assert.deepEqual(request.workspaceStrategy, {
          type: "existing_worktree",
          worktreePath,
        });
        assert.equal(preparedRuns.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect.each([
    { name: "no fallback is configured", fallback: null },
    { name: "the fallback already is the failed model", fallback: primarySelection },
  ])("skips the fallback when: $name", (testCase) =>
    Effect.gen(function* () {
      const { layer, dispatched } = harness({ fallback: testCase.fallback });
      yield* Effect.gen(function* () {
        const reactor = yield* DelegatedTaskCreditReactor.DelegatedTaskCreditReactor;
        yield* reactor.handle(terminalEvent(taskRow()));
        assert.equal(dispatched.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect.each([
    {
      name: "the failure is a self-clearing rate limit",
      task: { result: "Rate limit exceeded. Try again later." },
    },
    {
      name: "the task reaches the parent only through the blocking wait",
      task: { completionWake: "settled_only" as const },
    },
    {
      name: "the completion left only acknowledgement or disposal behind",
      task: { completionDelivery: { state: "delivered" as const, observedByRunId: null } },
    },
    { name: "the task was cancelled", task: { status: "cancelled" as const } },
    { name: "the task was interrupted", task: { status: "interrupted" as const } },
    {
      name: "the retry was already issued",
      task: {},
      hasReceipt: true,
    },
  ])("skips or does not retry when: $name", (testCase) =>
    Effect.gen(function* () {
      const { layer, dispatched } = harness({ hasReceipt: testCase.hasReceipt === true });
      yield* Effect.gen(function* () {
        const reactor = yield* DelegatedTaskCreditReactor.DelegatedTaskCreditReactor;
        yield* reactor.handle(
          terminalEvent(taskRow(testCase.task as Partial<OrchestrationV2Subagent>)),
        );
        assert.equal(dispatched.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );
});
