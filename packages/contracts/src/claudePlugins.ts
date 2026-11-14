import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** An installed Claude Code plugin, as `claude plugin list --json` reports it. */
export const ClaudeInstalledPlugin = Schema.Struct({
  id: TrimmedNonEmptyString,
  version: Schema.optional(Schema.String),
  /** user, project, local, or synced (from claude.ai, which Mem cannot change). */
  scope: Schema.String,
  enabled: Schema.Boolean,
  lastUpdated: Schema.optional(Schema.String),
});
export type ClaudeInstalledPlugin = typeof ClaudeInstalledPlugin.Type;

export const ClaudeAvailablePlugin = Schema.Struct({
  pluginId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  marketplaceName: Schema.String,
  installCount: Schema.optional(Schema.Number),
});
export type ClaudeAvailablePlugin = typeof ClaudeAvailablePlugin.Type;

export const ClaudeMarketplace = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** The GitHub repo, git URL or path the marketplace comes from. */
  origin: Schema.String,
});
export type ClaudeMarketplace = typeof ClaudeMarketplace.Type;

/** A skill in the user's own skills folder, outside any plugin. */
export const ClaudePersonalSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  path: TrimmedNonEmptyString,
});
export type ClaudePersonalSkill = typeof ClaudePersonalSkill.Type;

export const ClaudePluginsSnapshot = Schema.Struct({
  installed: Schema.Array(ClaudeInstalledPlugin),
  available: Schema.Array(ClaudeAvailablePlugin),
  marketplaces: Schema.Array(ClaudeMarketplace),
  skills: Schema.Array(ClaudePersonalSkill),
  skillsDirectory: Schema.String,
  /** Set when the CLI could not be run; the lists that need it are then empty. */
  error: Schema.NullOr(Schema.String),
});
export type ClaudePluginsSnapshot = typeof ClaudePluginsSnapshot.Type;

export const ClaudePluginAction = Schema.Literals([
  "install",
  "uninstall",
  "update",
  "enable",
  "disable",
  "marketplaceAdd",
  "marketplaceRemove",
  "marketplaceUpdate",
  "skillAdd",
  "skillRemove",
]);
export type ClaudePluginAction = typeof ClaudePluginAction.Type;

export const ClaudePluginsRunInput = Schema.Struct({
  action: ClaudePluginAction,
  /** Plugin id, marketplace name or source, a skill folder to copy in, or a skill name. */
  target: TrimmedNonEmptyString,
});
export type ClaudePluginsRunInput = typeof ClaudePluginsRunInput.Type;

export class ClaudePluginsError extends Schema.TaggedError<ClaudePluginsError>()(
  "ClaudePluginsError",
  { detail: TrimmedNonEmptyString },
) {
  override get message(): string {
    return this.detail;
  }
}
