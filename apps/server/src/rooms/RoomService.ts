import {
  CommandId,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  Room,
  RoomError,
  RoomId,
  RoomListResult,
  type RoomCreateInput,
  type RoomDeleteInput,
  type RoomSendInput,
  type RoomSetPausedInput,
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
import { forkParked } from "../serverActivation.ts";
import { addAgentReply, addUserMessage, beginTurn } from "./roomModerator.ts";

const RoomsFile = Schema.fromJsonString(Schema.Array(Room));
const decodeRooms = Schema.decodeUnknownEffect(RoomsFile);
const encodeRooms = Schema.encodeEffect(RoomsFile);

const ENDED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const roomError = (cause: unknown) =>
  new RoomError({ detail: cause instanceof Error ? cause.message : String(cause) });

export class RoomService extends Context.Service<
  RoomService,
  {
    readonly subscribe: () => Stream.Stream<RoomListResult, RoomError>;
    readonly create: (input: RoomCreateInput) => Effect.Effect<Room, RoomError>;
    readonly send: (input: RoomSendInput) => Effect.Effect<Room, RoomError>;
    readonly setPaused: (input: RoomSetPausedInput) => Effect.Effect<Room, RoomError>;
    readonly delete: (input: RoomDeleteInput) => Effect.Effect<void, RoomError>;
  }
>()("t3/rooms/RoomService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const launcher = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const random = yield* SecureRandom.SecureRandom;
  const filePath = path.join(config.stateDir, "rooms.json");
  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<void>(1);

  const loaded = yield* fileSystem.readFileString(filePath).pipe(
    Effect.flatMap((contents) => decodeRooms(contents)),
    Effect.catchTags({
      SchemaError: (cause) =>
        // Keep an unreadable file rather than overwriting it on the next save.
        Effect.logError("rooms.file-unreadable", { filePath, cause }).pipe(
          Effect.andThen(fileSystem.rename(filePath, `${filePath}.corrupt`)),
          Effect.as([] as ReadonlyArray<Room>),
          Effect.orElseSucceed(() => [] as ReadonlyArray<Room>),
        ),
    }),
    Effect.orElseSucceed(() => [] as ReadonlyArray<Room>),
  );
  const rooms = new Map(loaded.map((room) => [room.id, room]));

  const list = Ref.get(lastSpentUsd).pipe(
    Effect.map((spentTodayUsd) => ({ rooms: [...rooms.values()], spentTodayUsd })),
  );

  const save = Effect.fn("RoomService.save")(function* (room: Room) {
    rooms.set(room.id, room);
    yield* persist;
    return room;
  });

  const persist = Effect.gen(function* () {
    const contents = yield* encodeRooms([...rooms.values()]);
    yield* writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    yield* PubSub.publish(changes, undefined);
  }).pipe(Effect.mapError(roomError));

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const requireRoom = (roomId: RoomId) => {
    const room = rooms.get(roomId);
    return room === undefined
      ? Effect.fail(new RoomError({ detail: "That group chat no longer exists." }))
      : Effect.succeed(room);
  };

  const pauseWithNote = (room: Room, note: string): Room => ({ ...room, status: "paused", note });

  const startTurn = Effect.fn("RoomService.startTurn")(function* (room: Room) {
    if (room.speakerIndex === null) return room;
    const { prompt, room: started } = beginTurn(room, room.speakerIndex);
    const speaker = started.participants[room.speakerIndex]!;
    const key = `room:${room.id}:${yield* random.uuidV4()}`;
    return yield* threads
      .sendToThread({
        projectId: room.projectId,
        commandId: CommandId.make(key),
        messageId: MessageId.make(key),
        threadId: speaker.threadId,
        text: prompt,
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(
        Effect.as(started),
        Effect.catchCause((cause) =>
          Effect.logWarning("rooms.turn-start-failed", { roomId: room.id, cause }).pipe(
            Effect.as(pauseWithNote(room, `Couldn't start ${speaker.label}'s turn.`)),
          ),
        ),
      );
  });

  const stopSpeaker = Effect.fn("RoomService.stopSpeaker")(function* (room: Room) {
    const speaker = room.speakerIndex === null ? undefined : room.participants[room.speakerIndex];
    if (speaker === undefined) return;
    const stopId = yield* random.uuidV4();
    yield* threads
      .dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`room-stop:${room.id}:${stopId}`),
        threadId: speaker.threadId,
        reason: "Group chat paused.",
      })
      .pipe(Effect.catchCause((cause) => Effect.logWarning("rooms.stop-failed", { cause })));
  });

  const handleRunEnded = Effect.fn("RoomService.handleRunEnded")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
  ) {
    if (!ENDED_RUN_STATUSES.has(run.status)) return;
    // shortcut: a message typed straight into an agent's thread mid-turn also ends the turn here.
    const room = [...rooms.values()].find(
      (candidate) =>
        candidate.status === "running" &&
        candidate.speakerIndex !== null &&
        candidate.participants[candidate.speakerIndex]?.threadId === threadId,
    );
    if (room === undefined || room.speakerIndex === null) return;
    const speaker = room.participants[room.speakerIndex]!;
    if (run.status !== "completed") {
      yield* save(pauseWithNote(room, `${speaker.label}'s turn ended early (${run.status}).`));
      return;
    }
    const records = yield* projections
      .getThreadRecords(threadId, ["messages", "turnItems"])
      .pipe(Effect.mapError(roomError));
    const text = subagentResultForRun(records, run).text.trim() || "(no reply)";
    const replied = addAgentReply(room, room.speakerIndex, text, yield* now);
    yield* save(replied.status === "running" ? yield* startTurn(replied) : replied);
  }, lock.withPermit);

  // A turn that finished while the server was down never produces a live event.
  const recoverRunningRooms = Effect.forEach(
    [...rooms.values()].filter((room) => room.status === "running"),
    (room) =>
      Effect.gen(function* () {
        if (room.speakerIndex === null) return;
        const threadId = room.participants[room.speakerIndex]!.threadId;
        const { runs } = yield* projections
          .getThreadRecords(threadId, ["runs"])
          .pipe(Effect.mapError(roomError));
        const latest = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
        if (latest !== undefined) yield* handleRunEnded(threadId, latest);
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("rooms.recover-failed", { cause }))),
    { discard: true },
  );

  yield* forkParked(
    recoverRunningRooms.pipe(
      Effect.andThen(
        Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
          event.type === "run.updated"
            ? handleRunEnded(event.threadId, event.payload).pipe(
                Effect.catchCause((cause) => Effect.logWarning("rooms.advance-failed", { cause })),
              )
            : Effect.void,
        ),
      ),
    ),
  );

  return RoomService.of({
    // shortcut: sends every room's transcript on each turn, so very long histories would want paging.
    subscribe: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(list),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list)),
          );
        }),
      ),

    create: Effect.fn("RoomService.create")(function* (input: RoomCreateInput) {
      const roomId = RoomId.make(yield* random.uuidV4());
      const participants = yield* Effect.forEach(input.participants, (participant) =>
        launcher
          .launch({
            commandId: CommandId.make(`room-launch:${roomId}:${participant.label}`),
            projectId: input.projectId,
            title: `${input.title} · ${participant.label}`,
            modelSelection: participant.modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(
            Effect.map(({ threadId }) => ({
              threadId,
              label: participant.label,
              ...(participant.role === undefined ? {} : { role: participant.role }),
              seen: 0,
            })),
            Effect.mapError(roomError),
          ),
      );
      const room: Room = {
        id: roomId,
        projectId: input.projectId,
        title: input.title,
        participants,
        transcript: [],
        status: "idle",
        speakerIndex: null,
        turnsLeft: 0,
        maxRounds: input.maxRounds,
      };
      return yield* save(yield* startTurn(addUserMessage(room, input.message, yield* now)));
    }, lock.withPermit),

    send: Effect.fn("RoomService.send")(function* (input: RoomSendInput) {
      const room = yield* requireRoom(input.roomId);
      const added = addUserMessage(room, input.message, yield* now);
      // The agent already replying picks this up with its next prompt.
      return yield* save(room.status === "running" ? added : yield* startTurn(added));
    }, lock.withPermit),

    setPaused: Effect.fn("RoomService.setPaused")(function* (input: RoomSetPausedInput) {
      const room = yield* requireRoom(input.roomId);
      if (input.paused) {
        if (room.status !== "running") return room;
        yield* stopSpeaker(room);
        return yield* save({ ...room, status: "paused", note: "Paused." });
      }
      if (room.status !== "paused") return room;
      const { note: _note, ...cleared } = room;
      if (cleared.turnsLeft <= 0) return yield* save({ ...cleared, status: "idle" });
      return yield* save(
        yield* startTurn({
          ...cleared,
          status: "running",
          speakerIndex: cleared.speakerIndex ?? 0,
        }),
      );
    }, lock.withPermit),

    delete: Effect.fn("RoomService.delete")(function* (input: RoomDeleteInput) {
      const room = yield* requireRoom(input.roomId);
      if (room.status === "running") yield* stopSpeaker(room);
      rooms.delete(room.id);
      yield* persist;
    }, lock.withPermit),
  });
});

export const layer = Layer.effect(RoomService, make);
