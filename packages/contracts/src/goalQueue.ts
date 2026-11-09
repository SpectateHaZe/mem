import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const QueueGoalId = TrimmedNonEmptyString.pipe(Schema.brand("QueueGoalId"));
export type QueueGoalId = typeof QueueGoalId.Type;

export const QueueGoal = Schema.Struct({
  id: QueueGoalId,
  projectId: ProjectId,
  text: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  status: Schema.Literals(["pending", "running", "done", "failed"]),
  /** Failed runs so far; a goal gives up after a few. */
  attempts: Schema.Number,
  threadId: Schema.optional(ThreadId),
  note: Schema.optional(Schema.String),
});
export type QueueGoal = typeof QueueGoal.Type;

export const GoalQueue = Schema.Struct({
  goals: Schema.Array(QueueGoal),
  paused: Schema.Boolean,
  note: Schema.optional(Schema.String),
});
export type GoalQueue = typeof GoalQueue.Type;

export const QueueAddInput = Schema.Struct({
  projectId: ProjectId,
  text: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
});
export type QueueAddInput = typeof QueueAddInput.Type;

export const QueueSetPausedInput = Schema.Struct({ paused: Schema.Boolean });
export type QueueSetPausedInput = typeof QueueSetPausedInput.Type;

export const QueueRemoveInput = Schema.Struct({ goalId: QueueGoalId });
export type QueueRemoveInput = typeof QueueRemoveInput.Type;

export class QueueError extends Schema.TaggedError<QueueError>()("QueueError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
