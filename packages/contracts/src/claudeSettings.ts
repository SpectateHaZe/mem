import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);

/** Claude Code settings files, merging in this order: later scopes win. */
export const ClaudeSettingsScope = Schema.Literals(["user", "project", "local", "managed"]);
export type ClaudeSettingsScope = typeof ClaudeSettingsScope.Type;

export const ClaudeSettingsScopeFile = Schema.Struct({
  scope: ClaudeSettingsScope,
  label: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  /** Administrator-managed settings stay read-only; Mem only displays them. */
  writable: Schema.Boolean,
  exists: Schema.Boolean,
  contents: Schema.String,
  value: Schema.NullOr(JsonRecord),
  error: Schema.NullOr(TrimmedNonEmptyString),
});
export type ClaudeSettingsScopeFile = typeof ClaudeSettingsScopeFile.Type;

export const ClaudeSettingsSnapshot = Schema.Struct({
  scopes: Schema.Array(ClaudeSettingsScopeFile),
  merged: JsonRecord,
  /** The scope that supplied each top-level key of `merged`. */
  provenance: Schema.Record(Schema.String, ClaudeSettingsScope),
});
export type ClaudeSettingsSnapshot = typeof ClaudeSettingsSnapshot.Type;

export const ClaudeSettingsReadInput = Schema.Struct({
  /** Project directory whose `.claude` folder is read; empty reads user settings only. */
  cwd: Schema.String,
});
export type ClaudeSettingsReadInput = typeof ClaudeSettingsReadInput.Type;

export const ClaudeSettingsWriteInput = Schema.Struct({
  cwd: Schema.String,
  scope: ClaudeSettingsScope,
  contents: Schema.String,
});
export type ClaudeSettingsWriteInput = typeof ClaudeSettingsWriteInput.Type;

export class ClaudeSettingsWriteError extends Schema.TaggedError<ClaudeSettingsWriteError>()(
  "ClaudeSettingsWriteError",
  {
    reason: Schema.Literals(["scopeNotWritable", "invalidJson", "writeFailed"]),
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Claude settings write failed (${this.reason}): ${this.detail}`;
  }
}
