import {
  CommandId,
  CoworkError,
  CoworkListResult,
  CoworkSession,
  MessageId,
  type CoworkDeleteInput,
  type CoworkSendInput,
  type CoworkSetPausedInput,
  type CoworkStartInput,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
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
import { lastSpentUsd } from "../orchestration-v2/SpendingCapState.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { ENDED_RUN_STATUSES, makeEndedRunTracker } from "../rooms/endedRuns.ts";
import { readLimitStop } from "../rooms/limitStops.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  addUserFollowUp,
  beginDeliberationTurn,
  buildParallelThinkingPrompt,
  createInitialCowork,
  formatSessionContext,
  recordDeliberationReply,
  recordParallelThought,
} from "./coworkModerator.ts";

const CoworkFile = Schema.fromJsonString(Schema.Array(CoworkSession));
const decodeCoworks = Schema.decodeUnknownEffect(CoworkFile);
const encodeCoworks = Schema.encodeEffect(CoworkFile);

const coworkError = (cause: unknown) =>
  new CoworkError({ detail: cause instanceof Error ? cause.message : String(cause) });

export class CoworkService extends Context.Service<
  CoworkService,
  {
    readonly subscribe: () => Stream.Stream<CoworkListResult, CoworkError>;
    readonly start: (input: CoworkStartInput) => Effect.Effect<CoworkSession, CoworkError>;
    readonly send: (input: CoworkSendInput) => Effect.Effect<CoworkSession, CoworkError>;
    readonly setPaused: (input: CoworkSetPausedInput) => Effect.Effect<CoworkSession, CoworkError>;
    readonly delete: (input: CoworkDeleteInput) => Effect.Effect<void, CoworkError>;
  }
>()("t3/cowork/CoworkService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const launcher = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;
  const filePath = path.join(config.stateDir, "cowork.json");
  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<void>(1);

  const loaded = yield* fileSystem.readFileString(filePath).pipe(
    Effect.flatMap((contents) => decodeCoworks(contents)),
    Effect.catchTags({
      SchemaError: (cause) =>
        Effect.logError("cowork.file-unreadable", { filePath, cause }).pipe(
          Effect.andThen(fileSystem.rename(filePath, `${filePath}.corrupt`)),
          Effect.as([] as ReadonlyArray<CoworkSession>),
          Effect.orElseSucceed(() => [] as ReadonlyArray<CoworkSession>),
        ),
    }),
    Effect.orElseSucceed(() => [] as ReadonlyArray<CoworkSession>),
  );
  const sessions = new Map<ThreadId, CoworkSession>(
    loaded.map((session) => [session.sessionThreadId, session]),
  );

  const list = Ref.get(lastSpentUsd).pipe(
    Effect.map((spentTodayUsd) => ({ sessions: [...sessions.values()], spentTodayUsd })),
  );

  const persist = Effect.gen(function* () {
    const contents = yield* encodeCoworks([...sessions.values()]);
    yield* writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    yield* PubSub.publish(changes, undefined);
  }).pipe(Effect.mapError(coworkError));

  const save = Effect.fn("CoworkService.save")(function* (session: CoworkSession) {
    sessions.set(session.sessionThreadId, session);
    yield* persist;
    return session;
  });

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const requireSession = (sessionThreadId: ThreadId) => {
    const session = sessions.get(sessionThreadId);
    return session === undefined
      ? Effect.fail(new CoworkError({ detail: "No cowork session exists for this thread." }))
      : Effect.succeed(session);
  };

  const readSessionContext = (sessionThreadId: ThreadId) =>
    projections.getThreadRecords(sessionThreadId, ["messages"]).pipe(
      Effect.map(({ thread, messages }) =>
        formatSessionContext({
          title: thread.title,
          branch: thread.branch,
          messages,
        }),
      ),
      Effect.orElseSucceed(() => ""),
    );

  const dispatchPrompt = Effect.fn("CoworkService.dispatchPrompt")(function* (
    session: CoworkSession,
    threadId: ThreadId,
    prompt: string,
  ) {
    const key = `cowork:${session.sessionThreadId}:${yield* random.uuidV4()}`;
    return yield* threads
      .sendToThread({
        projectId: session.projectId,
        commandId: CommandId.make(key),
        messageId: MessageId.make(key),
        threadId,
        text: prompt,
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("cowork.turn-start-failed", {
            sessionThreadId: session.sessionThreadId,
            threadId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
  });

  const stopThreads = Effect.fn("CoworkService.stopThreads")(function* (
    session: CoworkSession,
    threadIds: ReadonlyArray<ThreadId>,
    reason: string,
  ) {
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        Effect.gen(function* () {
          const stopId = yield* random.uuidV4();
          yield* threads
            .dispatch({
              type: "thread.stop",
              commandId: CommandId.make(`cowork-stop:${session.sessionThreadId}:${stopId}`),
              threadId,
              reason,
            })
            .pipe(Effect.catchCause((cause) => Effect.logWarning("cowork.stop-failed", { cause })));
        }),
      { discard: true },
    );
  });

  const activeThreadIds = (session: CoworkSession): ReadonlyArray<ThreadId> => {
    if (session.phase === "thinking") {
      return session.participants
        .filter((participant) => participant.status === "thinking")
        .map((participant) => participant.threadId);
    }
    if (session.phase === "deliberating" && session.speakerIndex !== null) {
      const speaker = session.participants[session.speakerIndex];
      return speaker ? [speaker.threadId] : [];
    }
    return [];
  };

  const pauseWithNote = (
    session: CoworkSession,
    note: string,
    pausedFrom: "thinking" | "deliberating",
    updatedAt: string,
  ): CoworkSession => ({
    ...session,
    phase: "paused",
    pausedFrom,
    note,
    updatedAt,
  });

  const startDeliberationTurn = Effect.fn("CoworkService.startDeliberationTurn")(function* (
    session: CoworkSession,
  ) {
    if (session.speakerIndex === null || session.phase !== "deliberating") return session;
    const speaker = session.participants[session.speakerIndex]!;
    const context = speaker.seen === 0 ? yield* readSessionContext(session.sessionThreadId) : "";
    const { prompt, session: begun } = beginDeliberationTurn(
      session,
      session.speakerIndex,
      context,
    );
    const ok = yield* dispatchPrompt(begun, speaker.threadId, prompt);
    return ok
      ? begun
      : pauseWithNote(
          session,
          `Couldn't start ${speaker.label}'s turn.`,
          "deliberating",
          yield* now,
        );
  });

  const startParallelThinking = Effect.fn("CoworkService.startParallelThinking")(function* (
    session: CoworkSession,
    indices?: ReadonlyArray<number>,
  ) {
    const context = yield* readSessionContext(session.sessionThreadId);
    const targets =
      indices ??
      session.participants
        .map((_, index) => index)
        .filter((index) => session.participants[index]!.status === "thinking");
    const failedLabels: string[] = [];
    let updated = session;
    yield* Effect.forEach(
      targets,
      (index) =>
        Effect.gen(function* () {
          const peer = session.participants[index]!;
          const prompt = buildParallelThinkingPrompt(session, index, context);
          const ok = yield* dispatchPrompt(session, peer.threadId, prompt);
          if (!ok) {
            failedLabels.push(peer.label);
            updated = {
              ...updated,
              participants: updated.participants.map((p, i) =>
                i === index ? { ...p, status: "error" as const } : p,
              ),
            };
          }
        }),
      { concurrency: "unbounded" },
    );
    if (failedLabels.length > 0) {
      yield* stopThreads(
        updated,
        updated.participants.filter((p) => p.status === "thinking").map((p) => p.threadId),
        "Paused after a peer failed to start.",
      );
      return pauseWithNote(
        updated,
        `Couldn't start ${failedLabels.join(", ")}.`,
        "thinking",
        yield* now,
      );
    }
    return updated;
  });

  const firstEnd = makeEndedRunTracker();

  const replyText = (threadId: ThreadId, run: OrchestrationV2Run) =>
    projections.getThreadRecords(threadId, ["messages", "turnItems"]).pipe(
      Effect.map((records) => subagentResultForRun(records, run).text.trim() || "(no reply)"),
      Effect.catchCause((cause) =>
        Effect.logWarning("cowork.read-reply-failed", { cause }).pipe(Effect.as(null)),
      ),
    );

  const handleRunEnded = Effect.fn("CoworkService.handleRunEnded")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
  ) {
    if (!ENDED_RUN_STATUSES.has(run.status)) return;
    const match = [...sessions.values()]
      .map((session) => {
        if (session.phase === "thinking") {
          const idx = session.participants.findIndex(
            (participant) => participant.threadId === threadId && participant.status === "thinking",
          );
          return idx === -1 ? null : { session, speakerIndex: idx };
        }
        if (
          session.phase === "deliberating" &&
          session.speakerIndex !== null &&
          session.participants[session.speakerIndex]?.threadId === threadId
        ) {
          return { session, speakerIndex: session.speakerIndex };
        }
        return null;
      })
      .find((entry) => entry !== null);

    if (!match || !firstEnd(run.id)) return;
    const { session, speakerIndex } = match;
    const speaker = session.participants[speakerIndex]!;

    if (run.status !== "completed") {
      const limit = yield* readLimitStop(projections, settings, threadId, run);
      if (limit === "resumes") return;
      if (session.phase === "thinking") {
        const others = session.participants
          .filter((p, i) => i !== speakerIndex && p.status === "thinking")
          .map((p) => p.threadId);
        if (others.length > 0) {
          yield* stopThreads(session, others, "Cowork paused.");
        }
      }
      const erroredSession: CoworkSession = {
        ...session,
        participants: session.participants.map((p, i) =>
          i === speakerIndex ? { ...p, status: "error" as const } : p,
        ),
      };
      yield* save(
        pauseWithNote(
          erroredSession,
          limit === "waits"
            ? `${speaker.label} hit a usage limit. Resume cowork after it resets.`
            : `${speaker.label}'s turn ended early (${run.status}).`,
          session.phase === "thinking" ? "thinking" : "deliberating",
          yield* now,
        ),
      );
      return;
    }

    const text = yield* replyText(threadId, run);
    if (text === null) {
      yield* save(
        pauseWithNote(
          session,
          `Could not read ${speaker.label}'s reply. Resume to retry.`,
          session.phase === "thinking" ? "thinking" : "deliberating",
          yield* now,
        ),
      );
      return;
    }

    const messageId = yield* random.uuidV4();
    const timestamp = yield* now;
    if (session.phase === "thinking") {
      const next = recordParallelThought(session, speakerIndex, text, timestamp, messageId);
      yield* save(next.phase === "deliberating" ? yield* startDeliberationTurn(next) : next);
      return;
    }

    const replied = recordDeliberationReply(session, speakerIndex, text, timestamp, messageId);
    yield* save(replied.phase === "deliberating" ? yield* startDeliberationTurn(replied) : replied);
  }, lock.withPermit);

  const seedHandledRuns = Effect.forEach(
    [...sessions.values()],
    (session) =>
      Effect.forEach(
        session.participants,
        (participant, index) =>
          Effect.gen(function* () {
            const { runs } = yield* projections
              .getThreadRecords(participant.threadId, ["runs"])
              .pipe(Effect.mapError(coworkError));
            const latest = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
            const recovering =
              (session.phase === "thinking" && participant.status === "thinking") ||
              (session.phase === "deliberating" && session.speakerIndex === index);
            for (const run of runs) {
              if (!ENDED_RUN_STATUSES.has(run.status)) continue;
              if (recovering && run.id === latest?.id) continue;
              firstEnd(run.id);
            }
          }).pipe(Effect.catchCause((cause) => Effect.logWarning("cowork.seed-failed", { cause }))),
        { discard: true },
      ),
    { discard: true },
  );

  const recoverRunningCoworks = Effect.forEach(
    [...sessions.values()].filter(
      (session) => session.phase === "thinking" || session.phase === "deliberating",
    ),
    (session) =>
      Effect.forEach(
        activeThreadIds(session),
        (threadId) =>
          Effect.gen(function* () {
            const { runs } = yield* projections
              .getThreadRecords(threadId, ["runs"])
              .pipe(Effect.mapError(coworkError));
            const latest = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
            if (latest !== undefined) yield* handleRunEnded(threadId, latest);
          }).pipe(
            Effect.catchCause((cause) => Effect.logWarning("cowork.recover-failed", { cause })),
          ),
        { discard: true },
      ),
    { discard: true },
  );

  yield* forkParked(
    seedHandledRuns.pipe(
      Effect.andThen(recoverRunningCoworks),
      Effect.andThen(
        Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
          event.type === "run.updated"
            ? handleRunEnded(event.threadId, event.payload).pipe(
                Effect.catchCause((cause) => Effect.logWarning("cowork.advance-failed", { cause })),
              )
            : Effect.void,
        ),
      ),
    ),
  );

  return CoworkService.of({
    subscribe: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const spendChanges = Stream.tick("30 seconds").pipe(
            Stream.mapEffect(() => list),
            Stream.changesWith((left, right) => left.spentTodayUsd === right.spentTodayUsd),
          );
          return Stream.concat(
            Stream.fromEffect(list),
            Stream.merge(
              Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list)),
              spendChanges,
            ),
          );
        }),
      ),

    start: Effect.fn("CoworkService.start")(function* (input: CoworkStartInput) {
      const previous = sessions.get(input.sessionThreadId);
      if (previous !== undefined) {
        const toStop = activeThreadIds(previous);
        if (toStop.length > 0) {
          yield* stopThreads(previous, toStop, "Replaced by a new cowork session.");
        }
      }

      const parent = yield* projections
        .getThreadRecords(input.sessionThreadId, ["messages"])
        .pipe(Effect.mapError(coworkError));
      if (parent.thread.deletedAt !== null) {
        return yield* new CoworkError({ detail: "That session no longer exists." });
      }

      const launchBatchId = yield* random.uuidV4();
      const workspaceStrategy =
        parent.thread.worktreePath !== null
          ? ({
              type: "existing_worktree",
              worktreePath: parent.thread.worktreePath,
              ...(parent.thread.branch === null ? {} : { branch: parent.thread.branch }),
            } as const)
          : ({
              type: "root",
              ...(parent.thread.branch === null ? {} : { branch: parent.thread.branch }),
            } as const);

      // Each agent launches as a top-level peer thread (`relationshipToParent: null`), never a subagent.
      const participants = yield* Effect.forEach(input.participants, (participant, index) =>
        launcher
          .launch({
            commandId: CommandId.make(
              `cowork-launch:${input.sessionThreadId}:${launchBatchId}:${index}`,
            ),
            projectId: parent.thread.projectId,
            title: `${participant.label} · ${parent.thread.title}`,
            modelSelection: participant.modelSelection,
            runtimeMode: parent.thread.runtimeMode,
            interactionMode: "default",
            workspaceStrategy,
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(
            Effect.map(({ threadId }) => ({
              threadId,
              label: participant.label,
              ...(participant.role === undefined ? {} : { role: participant.role }),
              modelSelection: participant.modelSelection,
              seen: 0,
              status: "idle" as const,
            })),
            Effect.mapError(coworkError),
          ),
      );

      const topic =
        input.message.trim().length > 60
          ? `${input.message.trim().slice(0, 57)}...`
          : input.message.trim();
      const initial = createInitialCowork({
        sessionThreadId: input.sessionThreadId,
        projectId: parent.thread.projectId,
        topic,
        participants,
        maxRounds: input.maxRounds,
        message: input.message,
        messageId: yield* random.uuidV4(),
        now: yield* now,
      });

      const started =
        initial.phase === "thinking"
          ? yield* startParallelThinking(initial)
          : yield* startDeliberationTurn(initial);
      return yield* save(started);
    }, lock.withPermit),

    send: Effect.fn("CoworkService.send")(function* (input: CoworkSendInput) {
      const session = yield* requireSession(input.sessionThreadId);
      const updated = addUserFollowUp(session, input.message, yield* now, yield* random.uuidV4());
      const next =
        session.phase === "deliberating" || session.phase === "thinking"
          ? updated
          : yield* startDeliberationTurn(updated);
      return yield* save(next);
    }, lock.withPermit),

    setPaused: Effect.fn("CoworkService.setPaused")(function* (input: CoworkSetPausedInput) {
      const session = yield* requireSession(input.sessionThreadId);
      if (input.paused) {
        if (session.phase === "decided" || session.phase === "paused") return session;
        const toStop = activeThreadIds(session);
        if (toStop.length > 0) {
          yield* stopThreads(session, toStop, "Cowork paused.");
        }
        return yield* save(pauseWithNote(session, "Paused.", session.phase, yield* now));
      }
      if (session.phase !== "paused") return session;
      const { note: _note, pausedFrom, ...cleared } = session;
      const timestamp = yield* now;
      if (pausedFrom === "thinking") {
        const unfinished = cleared.participants
          .map((participant, index) => (participant.status !== "done" ? index : -1))
          .filter((index) => index !== -1);
        if (unfinished.length > 0) {
          const resetPeers: CoworkSession = {
            ...cleared,
            phase: "thinking",
            participants: cleared.participants.map((participant, index) =>
              unfinished.includes(index)
                ? { ...participant, status: "thinking" as const }
                : participant,
            ),
            updatedAt: timestamp,
          };
          return yield* save(yield* startParallelThinking(resetPeers, unfinished));
        }
        const intoDelib: CoworkSession = {
          ...cleared,
          phase: "deliberating",
          speakerIndex: 0,
          currentRound: Math.min(2, cleared.maxRounds),
          turnsLeft: Math.max(1, cleared.turnsLeft),
          updatedAt: timestamp,
        };
        return yield* save(yield* startDeliberationTurn(intoDelib));
      }
      if (cleared.turnsLeft <= 0) {
        return yield* save({
          ...cleared,
          phase: "decided",
          speakerIndex: null,
          updatedAt: timestamp,
        });
      }
      const resumed: CoworkSession = {
        ...cleared,
        phase: "deliberating",
        speakerIndex: cleared.speakerIndex ?? 0,
        updatedAt: timestamp,
      };
      return yield* save(yield* startDeliberationTurn(resumed));
    }, lock.withPermit),

    delete: Effect.fn("CoworkService.delete")(function* (input: CoworkDeleteInput) {
      const session = yield* requireSession(input.sessionThreadId);
      const toStop = activeThreadIds(session);
      if (toStop.length > 0) {
        yield* stopThreads(session, toStop, "Cowork session deleted.");
      }
      sessions.delete(input.sessionThreadId);
      yield* persist;
    }, lock.withPermit),
  });
});

export const layer = Layer.effect(CoworkService, make);
