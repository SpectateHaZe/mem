import {
  CommandId,
  DEFAULT_RUNTIME_MODE,
  GoalQueue,
  MessageId,
  QueueError,
  QueueGoalId,
  type OrchestrationV2Run,
  type QueueAddInput,
  type QueueGoal,
  type QueueRemoveInput,
  type QueueSetPausedInput,
  type ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { currentHit } from "../orchestration-v2/SpendingCapState.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import {
  goalPrompt,
  nextPendingGoal,
  recordFailedRun,
  settleGoal,
  updateGoal,
} from "./goalQueueLogic.ts";
import { ENDED_RUN_STATUSES } from "./roomModerator.ts";

const QueueFile = Schema.fromJsonString(GoalQueue);
const decodeQueue = Schema.decodeUnknownEffect(QueueFile);
const encodeQueue = Schema.encodeEffect(QueueFile);
const EMPTY_QUEUE: GoalQueue = { goals: [], paused: false };
const CAP_NOTE = "Paused: the daily spending cap was reached. Raise it or resume tomorrow.";

const queueError = (cause: unknown) =>
  new QueueError({ detail: cause instanceof Error ? cause.message : String(cause) });

export class GoalQueueService extends Context.Service<
  GoalQueueService,
  {
    readonly subscribe: () => Stream.Stream<GoalQueue, QueueError>;
    readonly add: (input: QueueAddInput) => Effect.Effect<GoalQueue, QueueError>;
    readonly setPaused: (input: QueueSetPausedInput) => Effect.Effect<GoalQueue, QueueError>;
    readonly remove: (input: QueueRemoveInput) => Effect.Effect<GoalQueue, QueueError>;
  }
>()("t3/rooms/GoalQueueService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const launcher = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const random = yield* SecureRandom.SecureRandom;
  const filePath = path.join(config.stateDir, "goal-queue.json");
  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<void>(1);

  let queue = yield* fileSystem.readFileString(filePath).pipe(
    Effect.flatMap((contents) => decodeQueue(contents)),
    Effect.catchTags({
      SchemaError: (cause) =>
        // Keep an unreadable file rather than overwriting it on the next save.
        Effect.logError("goal-queue.file-unreadable", { filePath, cause }).pipe(
          Effect.andThen(fileSystem.rename(filePath, `${filePath}.corrupt`)),
          Effect.as(EMPTY_QUEUE),
          Effect.orElseSucceed(() => EMPTY_QUEUE),
        ),
    }),
    Effect.orElseSucceed(() => EMPTY_QUEUE),
  );

  const setQueue = Effect.fn("GoalQueueService.setQueue")(function* (next: GoalQueue) {
    queue = next;
    const contents = yield* encodeQueue(queue);
    yield* writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    yield* PubSub.publish(changes, undefined);
    return queue;
  }, Effect.mapError(queueError));

  const startGoal = Effect.fn("GoalQueueService.startGoal")(function* (goal: QueueGoal) {
    const threadId =
      goal.threadId ??
      (yield* launcher.launch({
        commandId: CommandId.make(`queue-launch:${goal.id}`),
        projectId: goal.projectId,
        title: goal.text.slice(0, 60),
        modelSelection: goal.modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "server",
      })).threadId;
    const key = `queue:${goal.id}:${yield* random.uuidV4()}`;
    yield* threads.sendToThread({
      projectId: goal.projectId,
      commandId: CommandId.make(key),
      messageId: MessageId.make(key),
      threadId,
      text: goalPrompt(goal),
      attachments: [],
      mode: "auto",
      createdBy: "user",
      creationSource: "server",
    });
    return threadId;
  });

  const advance = Effect.gen(function* () {
    let goal = nextPendingGoal(queue);
    while (goal !== undefined) {
      if ((yield* Ref.get(currentHit)) !== undefined) {
        yield* setQueue({ ...queue, paused: true, note: CAP_NOTE });
        return;
      }
      const current = goal;
      const threadId = yield* startGoal(current).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("goal-queue.start-failed", { goalId: current.id, cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
      yield* setQueue(
        updateGoal(queue, current.id, (entry) =>
          threadId === null
            ? recordFailedRun(entry, "the agent couldn't be started.")
            : { ...entry, status: "running", threadId },
        ),
      );
      if (threadId !== null) return;
      goal = nextPendingGoal(queue);
    }
  });

  const stopThread = Effect.fn("GoalQueueService.stopThread")(function* (
    threadId: ThreadId,
    reason: string,
  ) {
    const stopId = yield* random.uuidV4();
    yield* threads
      .dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`queue-stop:${threadId}:${stopId}`),
        threadId,
        reason,
      })
      .pipe(Effect.catchCause((cause) => Effect.logWarning("goal-queue.stop-failed", { cause })));
  });

  const handleRunEnded = Effect.fn("GoalQueueService.handleRunEnded")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
  ) {
    if (!ENDED_RUN_STATUSES.has(run.status)) return;
    const goal = queue.goals.find(
      (candidate) => candidate.status === "running" && candidate.threadId === threadId,
    );
    if (goal === undefined) return;
    const heldBack = queue.paused || (yield* Ref.get(currentHit)) !== undefined;
    yield* setQueue(updateGoal(queue, goal.id, (entry) => settleGoal(entry, run.status, heldBack)));
    yield* advance;
  }, lock.withPermit);

  // A run that ended while the server was down never produces a live event.
  const recover = Effect.forEach(
    queue.goals.filter((goal) => goal.status === "running" && goal.threadId !== undefined),
    (goal) =>
      Effect.gen(function* () {
        const { runs } = yield* projections
          .getThreadRecords(goal.threadId!, ["runs"])
          .pipe(Effect.mapError(queueError));
        const latest = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
        if (latest !== undefined) yield* handleRunEnded(goal.threadId!, latest);
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("goal-queue.recover-failed", { cause })),
      ),
    { discard: true },
  );

  yield* forkParked(
    recover.pipe(
      Effect.andThen(lock.withPermit(advance)),
      Effect.catchCause((cause) => Effect.logWarning("goal-queue.resume-failed", { cause })),
      Effect.andThen(
        Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
          event.type === "run.updated"
            ? handleRunEnded(event.threadId, event.payload).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("goal-queue.advance-failed", { cause }),
                ),
              )
            : Effect.void,
        ),
      ),
    ),
  );

  const running = () => queue.goals.find((goal) => goal.status === "running");

  return GoalQueueService.of({
    subscribe: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(Effect.sync(() => queue)),
            Stream.fromSubscription(subscription).pipe(Stream.map(() => queue)),
          );
        }),
      ),

    add: Effect.fn("GoalQueueService.add")(function* (input: QueueAddInput) {
      const goal: QueueGoal = {
        ...input,
        id: QueueGoalId.make(yield* random.uuidV4()),
        status: "pending",
        attempts: 0,
      };
      yield* setQueue({ ...queue, goals: [...queue.goals, goal] });
      yield* advance;
      return queue;
    }, lock.withPermit),

    setPaused: Effect.fn("GoalQueueService.setPaused")(function* (input: QueueSetPausedInput) {
      if (input.paused) {
        yield* setQueue({ ...queue, paused: true, note: "Paused." });
        const goal = running();
        if (goal?.threadId !== undefined) yield* stopThread(goal.threadId, "Queue paused.");
        return queue;
      }
      const { note: _note, ...cleared } = queue;
      yield* setQueue({ ...cleared, paused: false });
      yield* advance;
      return queue;
    }, lock.withPermit),

    remove: Effect.fn("GoalQueueService.remove")(function* (input: QueueRemoveInput) {
      const goal = queue.goals.find((candidate) => candidate.id === input.goalId);
      yield* setQueue({
        ...queue,
        goals: queue.goals.filter((candidate) => candidate.id !== input.goalId),
      });
      if (goal?.status === "running" && goal.threadId !== undefined) {
        yield* stopThread(goal.threadId, "Removed from the queue.");
      }
      yield* advance;
      return queue;
    }, lock.withPermit),
  });
});

export const layer = Layer.effect(GoalQueueService, make);
