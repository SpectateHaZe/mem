import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import {
  isMemMasterThread,
  MEM_MASTER_THREAD_ID,
  MEM_MASTER_THREAD_TITLE,
} from "./MemMasterThread.ts";
import * as MemMasterThreadService from "./MemMasterThreadService.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection: ModelSelection = { instanceId, model: "gpt-5.4" };
const projectId = ProjectId.make("project:mem-master");
const at = "2026-11-11T00:00:00.000Z";

const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("The Mem thread never reaches a provider here."),
} as ProviderAdapter.ProviderAdapterV2["Service"];

let layerSequence = 0;

function makeLayer(overrides: Parameters<typeof ServerSettings.layerTest>[0] = {}) {
  layerSequence += 1;
  const database = SqlitePersistence.layerMemory;
  const layerStores = Layer.mergeAll(
    database,
    ProjectStore.layer.pipe(Layer.provide(database)),
    ProjectionStore.layer.pipe(Layer.provide(database)),
    EventStore.layer.pipe(Layer.provide(database)),
    EffectOutbox.layer.pipe(Layer.provide(database)),
    CommandReceiptStore.layer.pipe(Layer.provide(database)),
    Scheduler.layer,
    ProviderReplayHarness.layerWithRegistry(
      { name: `mem-master-${layerSequence}` },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: database, runEffectWorker: false },
    ),
    ServerSettings.layerTest(overrides),
  );
  const layerThreads = Layer.mergeAll(ProjectStore.layer, ThreadManagementService.layer).pipe(
    Layer.provideMerge(layerStores),
  );
  return MemMasterThreadService.layer.pipe(
    Layer.provideMerge(Layer.merge(layerThreads, layerStores)),
  );
}

const insertProject = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make("event:mem-master-project"),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Mem project",
      workspaceRoot: "/workspace/mem",
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  });
});

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
  });

const ensureMemThread = Effect.gen(function* () {
  const service = yield* MemMasterThreadService.MemMasterThreadService;
  return yield* service.ensure({ projectId, modelSelection });
});

const memThreads = (snapshot: { readonly threads: ReadonlyArray<OrchestrationV2ThreadShell> }) =>
  snapshot.threads.filter((thread) => thread.memMaster === true);

describe("Mem master thread", () => {
  it("treats threads written before the flag as ordinary", () => {
    assert.isFalse(isMemMasterThread({}));
    assert.isFalse(isMemMasterThread({ memMaster: false }));
    assert.isTrue(isMemMasterThread({ memMaster: true }));
  });

  it.effect("creates exactly one Mem thread, titled Mem and carried by its shell", () =>
    Effect.gen(function* () {
      yield* insertProject;
      const orchestrator = yield* Orchestrator.OrchestratorV2;

      assert.strictEqual(yield* ensureMemThread, MEM_MASTER_THREAD_ID);
      // A second ensure is a read, never a second thread.
      assert.strictEqual(yield* ensureMemThread, MEM_MASTER_THREAD_ID);

      const masters = memThreads(yield* orchestrator.getShellSnapshot());
      assert.lengthOf(masters, 1);
      assert.strictEqual(masters[0]?.id, MEM_MASTER_THREAD_ID);
      assert.strictEqual(masters[0]?.title, MEM_MASTER_THREAD_TITLE);
      assert.isTrue(masters[0]?.memMaster);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses to create a second Mem thread", () =>
    Effect.gen(function* () {
      yield* insertProject;
      yield* ensureMemThread;
      const orchestrator = yield* Orchestrator.OrchestratorV2;

      const refused = yield* orchestrator
        .dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "server",
          commandId: CommandId.make("create:second-master"),
          threadId: ThreadId.make("thread:second-master"),
          projectId,
          title: "Second Mem",
          memMaster: true,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "OrchestratorMemMasterThreadExistsError");

      assert.lengthOf(memThreads(yield* orchestrator.getShellSnapshot()), 1);
      assert.strictEqual(yield* ensureMemThread, MEM_MASTER_THREAD_ID);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("rejects deleting the Mem thread", () =>
    Effect.gen(function* () {
      yield* insertProject;
      yield* ensureMemThread;
      const orchestrator = yield* Orchestrator.OrchestratorV2;

      const refused = yield* orchestrator
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete:mem-master"),
          threadId: MEM_MASTER_THREAD_ID,
        })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "OrchestratorMemMasterThreadImmutableError");

      const projection = yield* orchestrator.getThreadProjection(MEM_MASTER_THREAD_ID);
      assert.isNull(projection.thread.deletedAt);
      assert.lengthOf(memThreads(yield* orchestrator.getShellSnapshot()), 1);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("stays first and unchanged through pin, unpin, reorder, and snooze", () =>
    Effect.gen(function* () {
      yield* insertProject;
      const orchestrator = yield* Orchestrator.OrchestratorV2;

      // The other thread is older and pinned, so only the sentinel keeps Mem above it.
      const other = ThreadId.make("thread:other");
      yield* createThread(other);
      yield* orchestrator.dispatch({
        type: "thread.pin",
        commandId: CommandId.make("pin:other"),
        threadId: other,
        orderKey: "a0",
      });
      yield* ensureMemThread;

      const moves: ReadonlyArray<OrchestrationV2Command> = [
        {
          type: "thread.pin",
          commandId: CommandId.make("move:mem-master:pin"),
          threadId: MEM_MASTER_THREAD_ID,
          orderKey: "z9",
        },
        {
          type: "thread.unpin",
          commandId: CommandId.make("move:mem-master:unpin"),
          threadId: MEM_MASTER_THREAD_ID,
        },
        {
          type: "thread.pin.reorder",
          commandId: CommandId.make("move:mem-master:pin-reorder"),
          threadId: MEM_MASTER_THREAD_ID,
          orderKey: "z8",
        },
        {
          type: "thread.active.reorder",
          commandId: CommandId.make("move:mem-master:active-reorder"),
          threadId: MEM_MASTER_THREAD_ID,
          orderKey: "z7",
        },
        {
          type: "thread.snooze",
          commandId: CommandId.make("move:mem-master:snooze"),
          threadId: MEM_MASTER_THREAD_ID,
          snoozedUntil: at,
        },
      ];
      yield* Effect.forEach(moves, (command) => orchestrator.dispatch(command), {
        discard: true,
      });

      const projection = yield* orchestrator.getThreadProjection(MEM_MASTER_THREAD_ID);
      assert.isNull(projection.thread.pinnedAt ?? null);
      assert.isNull(projection.thread.pinOrderKey ?? null);
      assert.isNull(projection.thread.activeOrderKey ?? null);

      const snapshot = yield* orchestrator.getShellSnapshot();
      assert.strictEqual(snapshot.threads[0]?.id, MEM_MASTER_THREAD_ID);
      assert.strictEqual(snapshot.threads[0]?.snoozedUntil, null);
      assert.strictEqual(snapshot.threads[0]?.memMaster, true);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("skips creation until a project and a Mem model exist", () =>
    Effect.gen(function* () {
      const service = yield* MemMasterThreadService.MemMasterThreadService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;

      assert.isNull(yield* service.ensure());
      yield* insertProject;
      assert.isNull(yield* service.ensure());
      assert.isEmpty((yield* orchestrator.getShellSnapshot()).threads);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "creates the Mem thread from the Mem model in settings when no selection is passed",
    () =>
      Effect.gen(function* () {
        yield* insertProject;
        const service = yield* MemMasterThreadService.MemMasterThreadService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;

        assert.strictEqual(yield* service.ensure(), MEM_MASTER_THREAD_ID);
        const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === MEM_MASTER_THREAD_ID,
        );
        assert.deepEqual(shell?.modelSelection, modelSelection);
      }).pipe(Effect.provide(makeLayer({ mem: { premiumModelSelection: modelSelection } }))),
  );
});
