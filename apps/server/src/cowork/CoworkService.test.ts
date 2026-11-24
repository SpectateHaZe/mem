import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CoworkService from "./CoworkService.ts";

const SESSION_THREAD_ID = ThreadId.make("thread:session");
const PROJECT_ID = ProjectId.make("project:1");

const model = (slug: string): ModelSelection => ({
  instanceId: "claudeAgent" as never,
  model: slug,
});

const makeCompletedRun = (threadId: ThreadId, id: string, ordinal: number): OrchestrationV2Run =>
  ({
    id: RunId.make(id),
    threadId,
    ordinal,
    providerInstanceId: "claudeAgent",
    modelSelection: model("sonnet"),
    providerThreadId: null,
    userMessageId: MessageId.make(`user:${id}`),
    rootNodeId: NodeId.make(`node:${id}`),
    activeAttemptId: null,
    status: "completed",
    requestedAt: DateTime.makeUnsafe("2026-11-24T12:00:00.000Z"),
    startedAt: DateTime.makeUnsafe("2026-11-24T12:00:01.000Z"),
    completedAt: DateTime.makeUnsafe("2026-11-24T12:00:02.000Z"),
    checkpointId: null,
    contextHandoffId: null,
  }) as unknown as OrchestrationV2Run;

it.effect(
  "launches equal non-subagent peers, runs Round 1 in parallel, and settles on a decision",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "cowork-test-" });
      const launches: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const sentPrompts: Array<{ threadId: ThreadId; text: string }> = [];
      const dispatches: Array<{ type: string; threadId?: ThreadId }> = [];
      const repliesByRunId = new Map<
        string,
        { threadId: ThreadId; run: OrchestrationV2Run; text: string }
      >();
      const domainEvents = yield* PubSub.unbounded<{
        readonly type: "run.updated";
        readonly threadId: ThreadId;
        readonly payload: OrchestrationV2Run;
      }>();
      const publishRunUpdated = (threadId: ThreadId, payload: OrchestrationV2Run) =>
        PubSub.publish(domainEvents, {
          type: "run.updated" as const,
          threadId,
          payload,
        });

      let peerCounter = 0;
      const coworkLayer = CoworkService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerConfig.ServerConfig, {
              stateDir,
            } as unknown as ServerConfig.ServerConfig["Service"]),
            Layer.succeed(ServerSettings.ServerSettingsService, {
              getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
            } as unknown as ServerSettings.ServerSettingsService["Service"]),
            Layer.succeed(ThreadLaunch.ThreadLaunchService, {
              launch: (input: ThreadLaunch.ThreadLaunchInput) =>
                Effect.sync(() => {
                  launches.push(input);
                  const threadId = ThreadId.make(`thread:peer-${peerCounter++}`);
                  return { threadId } as ThreadLaunch.ThreadLaunchResult;
                }),
            } as unknown as ThreadLaunch.ThreadLaunchService["Service"]),
            Layer.succeed(ThreadManagement.ThreadManagementService, {
              sendToThread: (input: { threadId: ThreadId; text: string }) =>
                Effect.sync(() => {
                  sentPrompts.push({ threadId: input.threadId, text: input.text });
                  return {} as never;
                }),
              dispatch: (command: { type: string; threadId?: ThreadId }) =>
                Effect.sync(() => {
                  dispatches.push(command);
                  return {} as never;
                }),
            } as unknown as ThreadManagement.ThreadManagementService["Service"]),
            Layer.succeed(Orchestrator.OrchestratorV2, {
              streamDomainEvents: Stream.fromPubSub(domainEvents),
            } as unknown as Orchestrator.OrchestratorV2["Service"]),
            Layer.succeed(ProjectionStore.ProjectionStoreV2, {
              getThreadRecords: (threadId: ThreadId) => {
                if (threadId === SESSION_THREAD_ID) {
                  return Effect.succeed({
                    thread: {
                      id: SESSION_THREAD_ID,
                      projectId: PROJECT_ID,
                      title: "Auth refactor",
                      branch: "feat/auth",
                      worktreePath: "/tmp/wt-auth",
                      runtimeMode: "auto-accept-edits",
                      deletedAt: null,
                    },
                    messages: [
                      { role: "user", text: "Need safer token refresh" },
                      { role: "assistant", text: "Current refresh lacks mutex" },
                    ],
                    runs: [],
                    turnItems: [],
                  } as never);
                }
                const peerReplies = [...repliesByRunId.values()].filter(
                  (entry) => entry.threadId === threadId,
                );
                return Effect.succeed({
                  runs: peerReplies.map((entry) => entry.run),
                  messages: peerReplies.map((entry, idx) => ({
                    id: MessageId.make(`msg:${entry.run.id}`),
                    threadId,
                    runId: entry.run.id,
                    nodeId: NodeId.make(`node:${entry.run.id}`),
                    role: "assistant",
                    text: entry.text,
                    attachments: [],
                    createdAt: DateTime.makeUnsafe("2026-11-24T12:00:02.000Z"),
                    ordinal: idx + 1,
                  })),
                  turnItems: [],
                } as never);
              },
            } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const cowork = yield* CoworkService.CoworkService;
        const updates = yield* Stream.toQueue(cowork.subscribe(), { capacity: 32 });
        const takeWithSession = () =>
          Effect.gen(function* () {
            while (true) {
              const next = yield* Queue.take(updates);
              const found = next.sessions.find((s) => s.sessionThreadId === SESSION_THREAD_ID);
              if (found !== undefined) return found;
            }
          });

        // Discard initial empty snapshot.
        yield* Queue.take(updates);

        const started = yield* cowork.start({
          sessionThreadId: SESSION_THREAD_ID,
          participants: [
            { label: "Claude", role: "Architect", modelSelection: model("sonnet") },
            { label: "Codex", modelSelection: model("gpt-5") },
          ],
          maxRounds: 2,
          message: "Mutex or single-flight queue?",
        });

        assert.equal(started.phase, "thinking");
        assert.equal(launches.length, 2);
        assert.isUndefined(launches[0]?.delegatedFrom);
        assert.isUndefined(launches[1]?.delegatedFrom);
        assert.isTrue(launches[0]?.cowork);
        assert.isTrue(launches[1]?.cowork);
        assert.deepEqual(launches[0]?.workspaceStrategy, {
          type: "existing_worktree",
          worktreePath: "/tmp/wt-auth",
          branch: "feat/auth",
        });
        // Both equal peers receive Round 1 prompts in parallel with session context.
        assert.equal(sentPrompts.length, 2);
        assert.include(sentPrompts[0]!.text, "Need safer token refresh");
        assert.include(sentPrompts[1]!.text, "Need safer token refresh");

        // Complete both Round 1 parallel thoughts.
        const peer0 = started.participants[0]!.threadId;
        const peer1 = started.participants[1]!.threadId;
        const run0 = makeCompletedRun(peer0, "run:0", 1);
        repliesByRunId.set(run0.id, {
          threadId: peer0,
          run: run0,
          text: "Use single-flight promise.",
        });
        yield* publishRunUpdated(peer0, run0);
        const afterFirst = yield* takeWithSession();
        assert.equal(afterFirst.phase, "thinking");

        const run1 = makeCompletedRun(peer1, "run:1", 1);
        repliesByRunId.set(run1.id, {
          threadId: peer1,
          run: run1,
          text: "Single-flight avoids lock leaks.",
        });
        yield* publishRunUpdated(peer1, run1);

        // Wait until deliberation starts and dispatches to speaker 0.
        const deliberating = yield* Effect.gen(function* () {
          while (true) {
            const snap = yield* takeWithSession();
            if (snap.phase === "deliberating") return snap;
          }
        });
        assert.equal(deliberating.speakerIndex, 0);
        assert.equal(sentPrompts.length, 3);
        assert.include(sentPrompts[2]!.text, "Single-flight avoids lock leaks.");

        // Complete Round 2 turns (2 turns for 2 peers).
        const run2 = makeCompletedRun(peer0, "run:2", 2);
        repliesByRunId.set(run2.id, {
          threadId: peer0,
          run: run2,
          text: "Agree on single-flight.",
        });
        yield* publishRunUpdated(peer0, run2);
        yield* takeWithSession();

        const run3 = makeCompletedRun(peer1, "run:3", 2);
        repliesByRunId.set(run3.id, {
          threadId: peer1,
          run: run3,
          text: "Settled.\nDecision: Deduplicate refresh calls with a single-flight promise.",
        });
        yield* publishRunUpdated(peer1, run3);

        const decided = yield* Effect.gen(function* () {
          while (true) {
            const snap = yield* takeWithSession();
            if (snap.phase === "decided") return snap;
          }
        });
        assert.equal(decided.decision, "Deduplicate refresh calls with a single-flight promise.");

        // Follow-up reopens deliberation, and pause stops the active speaker.
        const followed = yield* cowork.send({
          sessionThreadId: SESSION_THREAD_ID,
          message: "What about timeout?",
        });
        assert.equal(followed.phase, "deliberating");
        const paused = yield* cowork.setPaused({
          sessionThreadId: SESSION_THREAD_ID,
          paused: true,
        });
        assert.equal(paused.phase, "paused");
        assert.isTrue(dispatches.some((d) => d.type === "thread.stop"));

        yield* cowork.delete({ sessionThreadId: SESSION_THREAD_ID });
        const afterDelete = yield* Effect.gen(function* () {
          while (true) {
            const snap = yield* Queue.take(updates);
            if (snap.sessions.length === 0) return snap;
          }
        });
        assert.equal(afterDelete.sessions.length, 0);
        assert.equal(dispatches.filter((d) => d.type === "thread.delete").length, 2);
      }).pipe(Effect.provide(coworkLayer));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
