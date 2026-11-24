import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const CoworkParticipantStatus = Schema.Literals(["idle", "thinking", "done", "error"]);
export type CoworkParticipantStatus = typeof CoworkParticipantStatus.Type;

export const CoworkParticipant = Schema.Struct({
  threadId: ThreadId,
  label: TrimmedNonEmptyString,
  role: Schema.optional(TrimmedNonEmptyString),
  modelSelection: ModelSelection,
  /** How many transcript entries this peer has already been sent. */
  seen: Schema.Number,
  status: CoworkParticipantStatus,
});
export type CoworkParticipant = typeof CoworkParticipant.Type;

export const CoworkMessageKind = Schema.Literals(["user", "thought", "deliberation"]);
export type CoworkMessageKind = typeof CoworkMessageKind.Type;

export const CoworkMessage = Schema.Struct({
  id: TrimmedNonEmptyString,
  speaker: TrimmedNonEmptyString,
  kind: CoworkMessageKind,
  round: Schema.Number,
  text: Schema.String,
  summary: Schema.optional(Schema.String),
  at: Schema.String,
});
export type CoworkMessage = typeof CoworkMessage.Type;

export const CoworkPhase = Schema.Literals(["thinking", "deliberating", "decided", "paused"]);
export type CoworkPhase = typeof CoworkPhase.Type;

export const CoworkSession = Schema.Struct({
  sessionThreadId: ThreadId,
  projectId: ProjectId,
  topic: TrimmedNonEmptyString,
  participants: Schema.Array(CoworkParticipant),
  transcript: Schema.Array(CoworkMessage),
  phase: CoworkPhase,
  pausedFrom: Schema.optional(Schema.Literals(["thinking", "deliberating"])),
  decision: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  /** Index into `participants` of the active speaker during sequential deliberation. */
  speakerIndex: Schema.NullOr(Schema.Number),
  currentRound: Schema.Number,
  maxRounds: Schema.Number,
  turnsLeft: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type CoworkSession = typeof CoworkSession.Type;

export const CoworkListResult = Schema.Struct({
  sessions: Schema.Array(CoworkSession),
  spentTodayUsd: Schema.Number,
});
export type CoworkListResult = typeof CoworkListResult.Type;

const CoworkMaxRounds = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }));

export const CoworkStartInput = Schema.Struct({
  sessionThreadId: ThreadId,
  participants: Schema.Array(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      role: Schema.optional(TrimmedNonEmptyString),
      modelSelection: ModelSelection,
    }),
  ).check(Schema.isMinLength(2)),
  maxRounds: CoworkMaxRounds,
  message: TrimmedNonEmptyString,
});
export type CoworkStartInput = typeof CoworkStartInput.Type;

export const CoworkSendInput = Schema.Struct({
  sessionThreadId: ThreadId,
  message: TrimmedNonEmptyString,
});
export type CoworkSendInput = typeof CoworkSendInput.Type;

export const CoworkSetPausedInput = Schema.Struct({
  sessionThreadId: ThreadId,
  paused: Schema.Boolean,
});
export type CoworkSetPausedInput = typeof CoworkSetPausedInput.Type;

export const CoworkDeleteInput = Schema.Struct({
  sessionThreadId: ThreadId,
});
export type CoworkDeleteInput = typeof CoworkDeleteInput.Type;

export class CoworkError extends Schema.TaggedError<CoworkError>()("CoworkError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
