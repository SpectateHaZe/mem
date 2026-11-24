import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A subagent started from the composer whose result goes to the thread that started it. */
export const SubagentReportWatchInput = Schema.Struct({
  projectId: ProjectId,
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
  label: TrimmedNonEmptyString,
  task: TrimmedNonEmptyString,
});
export type SubagentReportWatchInput = typeof SubagentReportWatchInput.Type;

export class RoomError extends Schema.TaggedError<RoomError>()("RoomError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
