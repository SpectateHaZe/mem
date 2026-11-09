import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const RoomId = TrimmedNonEmptyString.pipe(Schema.brand("RoomId"));
export type RoomId = typeof RoomId.Type;

export const RoomParticipant = Schema.Struct({
  threadId: ThreadId,
  label: TrimmedNonEmptyString,
  role: Schema.optional(TrimmedNonEmptyString),
  /** How many transcript entries this agent has been sent. */
  seen: Schema.Number,
});
export type RoomParticipant = typeof RoomParticipant.Type;

const RoomMode = Schema.Literal("lead");

export const RoomHelper = Schema.Struct({
  label: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
});
export type RoomHelper = typeof RoomHelper.Type;

export const RoomMessage = Schema.Struct({
  speaker: TrimmedNonEmptyString,
  text: Schema.String,
  at: Schema.String,
});
export type RoomMessage = typeof RoomMessage.Type;

export const Room = Schema.Struct({
  id: RoomId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  /** One lead agent that delegates to `helpers`, instead of agents taking turns. */
  mode: Schema.optional(RoomMode),
  helpers: Schema.optional(Schema.Array(RoomHelper)),
  participants: Schema.Array(RoomParticipant),
  transcript: Schema.Array(RoomMessage),
  status: Schema.Literals(["idle", "running", "paused"]),
  note: Schema.optional(Schema.String),
  /** Index into `participants` of the agent currently replying. */
  speakerIndex: Schema.NullOr(Schema.Number),
  turnsLeft: Schema.Number,
  maxRounds: Schema.Number,
});
export type Room = typeof Room.Type;

export const RoomListResult = Schema.Struct({
  rooms: Schema.Array(Room),
  spentTodayUsd: Schema.Number,
});
export type RoomListResult = typeof RoomListResult.Type;

const MaxRounds = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }));

export const RoomCreateInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  /** In lead mode the first participant leads and the rest are its helpers. */
  mode: Schema.optional(RoomMode),
  participants: Schema.Array(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      role: Schema.optional(TrimmedNonEmptyString),
      modelSelection: ModelSelection,
    }),
  ).check(Schema.isMinLength(2)),
  maxRounds: MaxRounds,
  message: TrimmedNonEmptyString,
});
export type RoomCreateInput = typeof RoomCreateInput.Type;

export const RoomSendInput = Schema.Struct({ roomId: RoomId, message: TrimmedNonEmptyString });
export type RoomSendInput = typeof RoomSendInput.Type;

export const RoomSetPausedInput = Schema.Struct({ roomId: RoomId, paused: Schema.Boolean });
export type RoomSetPausedInput = typeof RoomSetPausedInput.Type;

export const RoomDeleteInput = Schema.Struct({ roomId: RoomId });
export type RoomDeleteInput = typeof RoomDeleteInput.Type;

export class RoomError extends Schema.TaggedError<RoomError>()("RoomError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
