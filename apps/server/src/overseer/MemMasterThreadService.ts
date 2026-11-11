/**
 * Keeps exactly one Mem thread in the environment. The service is the only creator; the
 * orchestrator refuses a second one, so a concurrent start leaves the first thread alone.
 */

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { MEM_MASTER_THREAD_ID, MEM_MASTER_THREAD_TITLE } from "./MemMasterThread.ts";

export interface MemMasterThreadInput {
  readonly projectId?: ProjectId | undefined;
  readonly threadId?: ThreadId | undefined;
  /** What the owner talks to Mem on; falls back to the Mem model in settings. */
  readonly modelSelection?: ModelSelection | undefined;
}

export interface MemMasterThreadServiceShape {
  /** The Mem thread's id, creating it when this environment has none. Null until it can be created. */
  readonly ensure: (input?: MemMasterThreadInput) => Effect.Effect<ThreadId | null>;
}

export class MemMasterThreadService extends Context.Service<
  MemMasterThreadService,
  MemMasterThreadServiceShape
>()("t3/overseer/MemMasterThreadService") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const scheduler = yield* Scheduler.Scheduler;
  const known = yield* Ref.make<ThreadId | null>(null);
  const attempts = yield* Ref.make(0);

  const nextCommandId = Effect.gen(function* () {
    const sequence = yield* Ref.updateAndGet(attempts, (value) => value + 1);
    const nowMs = yield* Clock.currentTimeMillis;
    return CommandId.make(`mem-master:create:${nowMs}:${sequence}`);
  });

  const defaultProjectId = Effect.gen(function* () {
    const shells = yield* projects.listShells();
    return shells[0]?.id ?? null;
  });

  const defaultModelSelection = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    return current.mem.premiumModelSelection ?? current.mem.economyModelSelection;
  });

  const create = Effect.fn("MemMasterThreadService.create")(function* (
    input: MemMasterThreadInput,
  ) {
    const projectId = input.projectId ?? (yield* defaultProjectId);
    if (projectId === null) {
      yield* Effect.logWarning("Skipped creating the Mem thread because no project exists yet.");
      return null;
    }
    const modelSelection = input.modelSelection ?? (yield* defaultModelSelection);
    if (modelSelection === null) {
      yield* Effect.logWarning(
        "Skipped creating the Mem thread because no Mem model is configured.",
      );
      return null;
    }
    const threadId = input.threadId ?? MEM_MASTER_THREAD_ID;
    yield* threads.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "server",
      commandId: yield* nextCommandId,
      threadId,
      projectId,
      title: MEM_MASTER_THREAD_TITLE,
      memMaster: true,
      modelSelection,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
    });
    return threadId;
  });

  const ensureOnce = Effect.fn("MemMasterThreadService.ensure")(function* (
    input: MemMasterThreadInput = {},
  ) {
    const knownId = yield* Ref.get(known);
    if (knownId !== null) return knownId;
    const existing = yield* projections.findMemMasterThreadId();
    if (existing !== null) {
      yield* Ref.set(known, existing);
      return existing;
    }
    const created = yield* create(input);
    if (created !== null) yield* Ref.set(known, created);
    return created;
  });

  const ensure = (input: MemMasterThreadInput = {}) =>
    ensureOnce(input).pipe(
      // Another caller created it first; that thread is the one and this call is done.
      Effect.catchTags({
        OrchestratorMemMasterThreadExistsError: (error) =>
          Ref.set(known, error.threadId).pipe(Effect.as(error.threadId)),
        OrchestratorThreadAlreadyExistsError: () =>
          projections.findMemMasterThreadId().pipe(
            Effect.tap((threadId) => (threadId === null ? Effect.void : Ref.set(known, threadId))),
            Effect.orElseSucceed(() => null),
          ),
      }),
      Effect.catch((cause) =>
        Effect.logWarning("Could not ensure the Mem thread", { cause }).pipe(Effect.as(null)),
      ),
    );

  const service = MemMasterThreadService.of({ ensure });

  // Startup attempt: a fresh install has no project or Mem model yet, so a slow retry keeps
  // trying until both exist. Once the thread is known every retry is one Ref read.
  yield* ensure();
  const lastAttemptMs = yield* Ref.make(0);
  const retry = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const previous = yield* Ref.get(lastAttemptMs);
    if (nowMs - previous < MEM_MASTER_RETRY_INTERVAL_MS) return;
    yield* Ref.set(lastAttemptMs, nowMs);
    yield* ensure();
  });
  yield* scheduler.register("mem-master-thread", retry);

  return service;
});

/** How often startup creation is retried while no project or Mem model exists yet. */
const MEM_MASTER_RETRY_INTERVAL_MS = 60_000;

export const layer = Layer.effect(MemMasterThreadService, make);
