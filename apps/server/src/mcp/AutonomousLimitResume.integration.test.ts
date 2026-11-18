import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as UsageLimitRecoveryWorker from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-test" };

const AUTONOMOUS = { mem: { autonomous: true } } as const;

type Case = {
  readonly name: string;
  readonly stops: "child" | "session";
  readonly failure: {
    readonly class: "usage_limit" | "provider_error";
    readonly message: string;
    readonly resetInMinutes: number | null;
  };
  /** Rebuild the recovery worker against the same database before the reset, as a restart does. */
  readonly restart: boolean;
  /** Stop the limited child before its reset, which calls the resume off. */
  readonly stopChild?: boolean;
  /** How long after the stop each later sweep runs, and whether the session was resumed by then. */
  readonly checks: ReadonlyArray<{ readonly afterMinutes: number; readonly resumed: boolean }>;
};

// Mem's autonomous mode resumes a session stopped by a limit once the limit resets, even with the
// general auto-resume setting off, and leaves every other kind of stop alone.
it.effect.each<Case>([
  {
    name: "a delegated child stopped by a rate limit with no reset time resumes after the backoff",
    stops: "child",
    failure: { class: "provider_error", message: "429 Too Many Requests", resetInMinutes: null },
    restart: false,
    checks: [
      { afterMinutes: 4, resumed: false },
      { afterMinutes: 6, resumed: true },
    ],
  },
  {
    name: "a delegated child held for its limit resume still reports when the user stops it",
    stops: "child",
    failure: { class: "provider_error", message: "429 Too Many Requests", resetInMinutes: null },
    restart: false,
    stopChild: true,
    checks: [],
  },
  {
    name: "a session stopped by a usage limit resumes at the provider's reset",
    stops: "session",
    failure: { class: "usage_limit", message: "Claude usage limit reached.", resetInMinutes: 60 },
    restart: false,
    checks: [
      { afterMinutes: 59, resumed: false },
      { afterMinutes: 61, resumed: true },
    ],
  },
  {
    name: "a session that failed for another reason is not resumed",
    stops: "session",
    failure: {
      class: "provider_error",
      message: "The tool call had bad arguments.",
      resetInMinutes: null,
    },
    restart: false,
    checks: [{ afterMinutes: 3 * 60, resumed: false }],
  },
  {
    name: "a pending resume survives a restart and a computer that was off for over a day",
    stops: "session",
    failure: { class: "usage_limit", message: "Claude usage limit reached.", resetInMinutes: 60 },
    restart: true,
    checks: [{ afterMinutes: 26 * 60, resumed: true }],
  },
])("$name", ({ stops, failure, restart, stopChild, checks }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("autonomous-limit-resume");
      const turns: Array<{
        readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
        readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
      }> = [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities: ClaudeProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  turns.push({ turn, events });
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: null,
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: () => Effect.die("unused"),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      const layerAdapters = ProviderAdapterRegistry.layerSingle(adapter);
      const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
        { name: "autonomous-limit-resume" },
        layerAdapters,
        { runEffectWorker: false, settings: AUTONOMOUS },
      );
      const layerOrchestration = Layer.merge(
        layerOrchestrator,
        ThreadManagementService.layer.pipe(
          Layer.provide(layerOrchestrator),
          Layer.provide(ServerSettings.layerTest(AUTONOMOUS)),
          Layer.provide(
            CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
        ),
      );
      const sweeps = new Map<string, Effect.Effect<void>>();
      const layerScheduler = Layer.succeed(Scheduler.Scheduler, {
        register: <E, R>(name: string, work: Effect.Effect<void, E, R>) =>
          Effect.gen(function* () {
            const context = yield* Effect.context<R>();
            sweeps.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
          }),
      });
      const layerProjections = ProjectionStore.layer.pipe(
        Layer.provide(SqlitePersistence.layerMemory),
      );
      const layerSettings = ServerSettings.layerTest(AUTONOMOUS);
      const layerRecovery = UsageLimitRecoveryWorker.layer.pipe(
        Layer.provide(Layer.mergeAll(layerScheduler, layerProjections, layerSettings)),
      );
      const layerTest = Layer.mergeAll(
        OrchestratorMcpService.layer.pipe(
          Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
          Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        ),
        layerRecovery,
        layerProjections,
        layerSettings,
      ).pipe(
        Layer.provideMerge(layerOrchestration),
        Layer.provide(
          Layer.mergeAll(
            layerAdapters,
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            ServerSettings.layerTest(AUTONOMOUS),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sweep = Effect.andThen(
          Effect.suspend(() => sweeps.get("usage-limit-recovery")!),
          worker.drain(),
        );
        const parentThreadId = ThreadId.make("thread:autonomous-limit-parent");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const turnRunning = () =>
          watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-parent"),
          threadId: parentThreadId,
          projectId: ProjectId.make("project:autonomous-limit"),
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const parentRunning = yield* turnRunning();
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-parent"),
          threadId: parentThreadId,
          messageId: MessageId.make("message:start-parent"),
          text: "Build the feature",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(parentRunning);

        let stoppedThreadId = parentThreadId;
        let firstPrompt = "Build the feature";
        if (stops === "child") {
          const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
          const childRunning = yield* turnRunning();
          yield* orchestrator.dispatch({
            type: "delegated_task.request",
            commandId: CommandId.make("delegate"),
            parentThreadId,
            parentRunId: parentRun.id,
            parentNodeId: parentRun.rootNodeId!,
            task: "Review the change",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            completionWake: "always",
            createdBy: "agent",
            creationSource: "mcp",
          });
          yield* worker.drain();
          yield* Fiber.join(childRunning);
          const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
          stoppedThreadId = task.childThreadId!;
          firstPrompt = "Review the change";
        }
        const stopped = turns.find((entry) => entry.turn.threadId === stoppedThreadId)!;
        const stoppedTurn = (yield* orchestrator.getThreadProjection(stoppedThreadId))
          .providerTurns[0]!;

        const now = yield* DateTime.now;
        const runFailed = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === stopped.turn.runId &&
            event.payload.status === "failed",
        );
        yield* Effect.forEach(
          [
            {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...stoppedTurn, status: "failed", completedAt: now },
            },
            {
              type: "turn.terminal",
              driver,
              providerThreadId: stoppedTurn.providerThreadId,
              providerTurnId: stoppedTurn.id,
              runOrdinal: stopped.turn.runOrdinal,
              failureItemOrdinal: 1,
              status: "failed",
              failure: {
                class: failure.class,
                message: failure.message,
                code: null,
                retryable: null,
                ...(failure.resetInMinutes === null
                  ? {}
                  : {
                      resetAt: DateTime.formatIso(
                        DateTime.add(now, { minutes: failure.resetInMinutes }),
                      ),
                    }),
              },
              threadDisposition: "reusable",
            },
          ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
          (event) => Queue.offer(stopped.events, event),
          { discard: true },
        );
        yield* Fiber.join(runFailed);
        yield* worker.drain();
        // The sweep runs every few seconds, so it arms the stop right away.
        yield* sweep;
        const parentTask = Effect.map(
          orchestrator.getThreadProjection(parentThreadId),
          (projection) => projection.subagents,
        );
        if (stops === "child") {
          // The limit will be resumed, so the parent is not told the task failed.
          const [held] = yield* parentTask;
          assert.notEqual(held?.status, "failed");
          assert.isNull(held?.result ?? null);
        }
        const taskSettled = (status: string) =>
          watch(
            (event) =>
              event.type === "subagent.updated" &&
              event.threadId === parentThreadId &&
              event.payload.status === status,
          );
        if (stopChild) {
          const failedTask = yield* taskSettled("failed");
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("stop-child"),
            threadId: stoppedThreadId,
            reason: "Stopped by the user.",
          });
          yield* worker.drain();
          yield* Fiber.join(failedTask);
          const [released] = yield* parentTask;
          assert.equal(released?.status, "failed");
          return;
        }

        if (restart) {
          const armed = (yield* orchestrator.getThreadProjection(stoppedThreadId)).thread
            .limitRecovery;
          assert.equal(armed?.autoResume, true);
          // A fresh worker keeps nothing in memory; it can only find the resume in the database.
          sweeps.clear();
          const restartScope = yield* Scope.make();
          yield* Layer.buildWithScope(
            Layer.fresh(UsageLimitRecoveryWorker.layer).pipe(
              Layer.provide(
                Layer.mergeAll(
                  layerScheduler,
                  Layer.succeed(
                    ProjectionStore.ProjectionStoreV2,
                    yield* ProjectionStore.ProjectionStoreV2,
                  ),
                  Layer.succeed(
                    ThreadManagementService.ThreadManagementService,
                    yield* ThreadManagementService.ThreadManagementService,
                  ),
                  Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
                  Layer.succeed(
                    ServerSettings.ServerSettingsService,
                    yield* ServerSettings.ServerSettingsService,
                  ),
                ),
              ),
            ),
            restartScope,
          );
          assert.isTrue(sweeps.has("usage-limit-recovery"));
        }

        const continuePrompt = "Continue where you left off.";
        let elapsed = 0;
        for (const check of checks) {
          yield* TestClock.adjust(`${check.afterMinutes - elapsed} minutes`);
          elapsed = check.afterMinutes;
          yield* sweep;
          const messages = (yield* orchestrator.getThreadProjection(
            stoppedThreadId,
          )).messages.flatMap((message) => (message.role === "user" ? [message.text] : []));
          assert.deepEqual(
            messages,
            check.resumed ? [firstPrompt, continuePrompt] : [firstPrompt],
            `after ${check.afterMinutes} minutes`,
          );
        }

        if (stops === "child") {
          // The resumed run's end settles the one original task, not a second follow-up task.
          const resumed = turns.at(-1)!;
          const resumedTurn = {
            id: ProviderTurnId.make(`provider-turn:${resumed.turn.attemptId}`),
            providerThreadId: resumed.turn.providerThread.id,
            nodeId: resumed.turn.rootNodeId,
            runAttemptId: resumed.turn.attemptId,
            nativeTurnRef: null,
            ordinal: resumed.turn.providerTurnOrdinal,
            startedAt: yield* DateTime.now,
          };
          const resumedRunId = resumed.turn.runId;
          const runWaiting = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === resumedRunId &&
              event.payload.status === "waiting",
          );
          const completedTask = yield* taskSettled("completed");
          const runCompleted = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === resumedRunId &&
              event.payload.status === "completed",
          );
          const doneAt = yield* DateTime.now;
          yield* Effect.forEach(
            [
              {
                type: "provider_turn.updated",
                driver,
                providerTurn: { ...resumedTurn, status: "completed", completedAt: doneAt },
              },
              {
                type: "turn.terminal",
                driver,
                providerThreadId: resumedTurn.providerThreadId,
                providerTurnId: resumedTurn.id,
                runOrdinal: resumed.turn.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              },
            ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
            (event) => Queue.offer(resumed.events, event),
            { discard: true },
          );
          // The run waits for its checkpoint capture, which the effect worker runs.
          yield* Fiber.join(runWaiting);
          yield* worker.drain();
          yield* Fiber.join(runCompleted);
          yield* worker.drain();
          // The task settles from the run's terminal event stream, a moment after the run.
          yield* Fiber.join(completedTask);
          const settled = yield* parentTask;
          assert.equal(settled.length, 1);
          assert.equal(settled[0]?.status, "completed");
        }
      }).pipe(Effect.provide(layerTest));
    }),
  ),
);
