import {
  DEFAULT_DISCORD_PRESENCE_SETTINGS,
  resolveDiscordPresenceShowProjectName,
  type DiscordPresenceSettings,
} from "@t3tools/contracts";
import { ClockIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { DraftInput } from "../ui/draft-input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ScopedSwitch } from "./ScopedSwitch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Sample values for the preview, so the owner never sees their own thread titles. */
const PREVIEW_AGENTS = "2 agents";
const PREVIEW_PROJECT = "my-project";
const PREVIEW_MODEL = "gpt-5.4";
const PREVIEW_MODE = "mem in control";

const DEFAULTS = DEFAULT_DISCORD_PRESENCE_SETTINGS;

/** Mirrors the server's template rules, so the preview matches the card Discord will show. */
function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template
    .replace(/\{(agents|project|model|mode)\}/g, (_match, key: string) => values[key] ?? "")
    .split("·")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" · ")
    .replace(/\s+/g, " ")
    .trim();
}

function ImageTile({
  imageKey,
  imageText,
  className,
}: {
  imageKey: string;
  imageText: string;
  className: string;
}) {
  const tile = (
    <div
      className={cn(
        "flex items-center justify-center overflow-hidden rounded-lg bg-muted",
        className,
      )}
    >
      <span className="px-1 text-center text-3xs break-all text-muted-foreground">{imageKey}</span>
    </div>
  );
  if (imageText === "") return tile;
  return (
    <Tooltip>
      <TooltipTrigger render={tile} />
      <TooltipPopup side="top">{imageText}</TooltipPopup>
    </Tooltip>
  );
}

/** Approximates Discord's profile card, which renders asset keys as uploaded images. */
function DiscordCardPreview({
  presence,
  mode,
}: {
  presence: DiscordPresenceSettings;
  mode: string;
}) {
  const values = {
    agents: PREVIEW_AGENTS,
    project: (presence.showProjectName ?? false) ? PREVIEW_PROJECT : "",
    model: PREVIEW_MODEL,
    mode,
  };
  const details = renderTemplate(presence.detailsTemplate, values) || presence.idleText.trim();
  const state = renderTemplate(presence.stateTemplate, values);
  const smallImageKey = presence.smallImageKey.trim();
  return (
    <div className="w-full max-w-sm rounded-xl border border-border bg-card p-3 text-card-foreground shadow-lg">
      <p className="text-3xs font-semibold tracking-wide text-muted-foreground uppercase">
        Playing a game
      </p>
      <div className="mt-2 flex items-start gap-3">
        <div className="relative shrink-0">
          <ImageTile
            imageKey={presence.largeImageKey.trim() || "Mem"}
            imageText={presence.largeImageText.trim()}
            className="size-16"
          />
          {smallImageKey !== "" && (
            <ImageTile
              imageKey={smallImageKey}
              imageText={presence.smallImageText.trim()}
              className="absolute -end-1 -bottom-1 size-6 rounded-full border-2 border-card bg-muted"
            />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-0.5 pt-0.5">
          <p className="truncate text-sm font-semibold">{details}</p>
          {state !== "" && <p className="truncate text-xs text-muted-foreground">{state}</p>}
          {presence.showElapsedTimer && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <ClockIcon className="size-3" aria-hidden="true" />
              00:00 elapsed
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-border pt-2">
        <span className="flex size-4 items-center justify-center rounded-full bg-muted text-4xs">
          M
        </span>
        <span className="text-xs font-semibold">Mem</span>
      </div>
    </div>
  );
}

export function DiscordRpcSettingsPanel() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const presence = settings.discordPresence;
  const showProjectName = resolveDiscordPresenceShowProjectName(settings);
  const mixed = useScopedSettingsMixed(["discordPresence"]);
  const clientIdMixed = useScopedSettingsMixed(["discordClientId"]);
  const update = (patch: Partial<DiscordPresenceSettings>) =>
    updateSettings({ discordPresence: patch });

  return (
    <SettingsPageContainer>
      <SettingsSection id="discord-presence" title="Presence">
        <SettingsRow
          serverScoped
          {...searchableSetting("discord-enabled")}
          description="Shows what Mem is doing on your Discord profile. Turning it off clears the card and stops talking to Discord."
          settingKeys={["discordPresence"]}
          control={
            <ScopedSwitch
              settingKeys={["discordPresence"]}
              checked={presence.enabled}
              onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
              aria-label="Show Discord presence"
            />
          }
        />
        <SettingsRow
          serverScoped
          {...searchableSetting("discord-status")}
          description="Application ID of the Discord app whose name and images appear on the card. Leave the default unless you registered your own."
          settingKeys={["discordClientId"]}
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-48"
              inputMode="numeric"
              value={settings.discordClientId}
              onCommit={(next) => {
                const clientId = next.trim();
                if (/^\d*$/.test(clientId)) updateSettings({ discordClientId: clientId });
              }}
              placeholder={clientIdMixed ? "Mixed" : "Off"}
              aria-label="Discord Application ID"
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="discord-text" title="Card text">
        <SettingsRow
          serverScoped
          {...searchableSetting("discord-details")}
          description="First line of the card. {agents} is the live count with its noun (“1 agent”, “3 agents”). You can also use {project}, {model}, and {mode}."
          settingKeys={["discordPresence"]}
          resetAction={
            presence.detailsTemplate !== DEFAULTS.detailsTemplate && !mixed ? (
              <SettingResetButton
                label="details template"
                onClick={() => update({ detailsTemplate: DEFAULTS.detailsTemplate })}
              />
            ) : null
          }
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-72"
              value={presence.detailsTemplate}
              onCommit={(next) => update({ detailsTemplate: next })}
              placeholder={mixed ? "Mixed" : DEFAULTS.detailsTemplate}
              spellCheck={false}
              aria-label="Details template"
            />
          }
        />
        <SettingsRow
          serverScoped
          {...searchableSetting("discord-state")}
          description="Second line of the card, for the same placeholders. Leave it empty to hide the line."
          settingKeys={["discordPresence"]}
          resetAction={
            presence.stateTemplate !== DEFAULTS.stateTemplate && !mixed ? (
              <SettingResetButton
                label="state template"
                onClick={() => update({ stateTemplate: DEFAULTS.stateTemplate })}
              />
            ) : null
          }
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-72"
              value={presence.stateTemplate}
              onCommit={(next) => update({ stateTemplate: next })}
              placeholder={mixed ? "Mixed" : DEFAULTS.stateTemplate}
              spellCheck={false}
              aria-label="State template"
            />
          }
        />
        <SettingsRow
          serverScoped
          {...searchableSetting("discord-idle-text")}
          description="Shown instead of the details line while Mem is in control and no agent is running."
          settingKeys={["discordPresence"]}
          resetAction={
            presence.idleText !== DEFAULTS.idleText && !mixed ? (
              <SettingResetButton
                label="idle text"
                onClick={() => update({ idleText: DEFAULTS.idleText })}
              />
            ) : null
          }
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-56"
              value={presence.idleText}
              onCommit={(next) => update({ idleText: next })}
              placeholder={mixed ? "Mixed" : DEFAULTS.idleText}
              aria-label="Idle text"
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="discord-images" title="Images">
        <SettingsRow
          serverScoped
          {...searchableSetting("discord-large-image")}
          description="Asset key uploaded to your Discord application, and the text shown when someone hovers it. Leaving the key empty leaves this art off the card."
          settingKeys={["discordPresence"]}
          resetAction={
            presence.largeImageKey !== DEFAULTS.largeImageKey && !mixed ? (
              <SettingResetButton
                label="large image"
                onClick={() => update({ largeImageKey: DEFAULTS.largeImageKey })}
              />
            ) : null
          }
        >
          <div className="grid max-w-2xl gap-2 pb-3.5 sm:grid-cols-2">
            <DraftInput
              size="sm"
              key={`large-key:${mixed}:${presence.largeImageKey}`}
              value={presence.largeImageKey}
              onCommit={(next) => update({ largeImageKey: next.trim() })}
              placeholder={mixed ? "Mixed" : "Asset key"}
              spellCheck={false}
              aria-label="Large image asset key"
            />
            <DraftInput
              size="sm"
              key={`large-text:${mixed}:${presence.largeImageText}`}
              value={presence.largeImageText}
              onCommit={(next) => update({ largeImageText: next })}
              placeholder={mixed ? "Mixed" : "Hover text"}
              aria-label="Large image hover text"
            />
          </div>
        </SettingsRow>
        <SettingsRow
          serverScoped
          {...searchableSetting("discord-small-image")}
          description="Small badge drawn over the large image's corner. Empty leaves it off."
          settingKeys={["discordPresence"]}
          resetAction={
            presence.smallImageKey !== DEFAULTS.smallImageKey && !mixed ? (
              <SettingResetButton
                label="small image"
                onClick={() => update({ smallImageKey: DEFAULTS.smallImageKey })}
              />
            ) : null
          }
        >
          <div className="grid max-w-2xl gap-2 pb-3.5 sm:grid-cols-2">
            <DraftInput
              size="sm"
              key={`small-key:${mixed}:${presence.smallImageKey}`}
              value={presence.smallImageKey}
              onCommit={(next) => update({ smallImageKey: next.trim() })}
              placeholder={mixed ? "Mixed" : "Asset key"}
              spellCheck={false}
              aria-label="Small image asset key"
            />
            <DraftInput
              size="sm"
              key={`small-text:${mixed}:${presence.smallImageText}`}
              value={presence.smallImageText}
              onCommit={(next) => update({ smallImageText: next })}
              placeholder={mixed ? "Mixed" : "Hover text"}
              aria-label="Small image hover text"
            />
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="discord-card" title="Card options">
        <SettingsRow
          serverScoped
          {...searchableSetting("discord-elapsed-timer")}
          description="Counts up from when the current presence started."
          settingKeys={["discordPresence"]}
          control={
            <ScopedSwitch
              settingKeys={["discordPresence"]}
              checked={presence.showElapsedTimer}
              onCheckedChange={(checked) => update({ showElapsedTimer: Boolean(checked) })}
              aria-label="Show elapsed timer"
            />
          }
        />
        <SettingsRow
          serverScoped
          {...searchableSetting("discord-show-project")}
          description="Adds the project's name to the card. Your project names can be private, so this stays off by default."
          settingKeys={["discordPresence", "discordPresenceShowProjectName"]}
          resetAction={
            showProjectName && !mixed ? (
              <SettingResetButton
                label="project name on the card"
                onClick={() => update({ showProjectName: false })}
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["discordPresence"]}
              checked={showProjectName}
              onCheckedChange={(checked) => update({ showProjectName: Boolean(checked) })}
              aria-label="Show project name in Discord status"
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="discord-preview" title="Preview">
        <SettingsRow
          title="Your Discord profile card"
          description={
            presence.enabled
              ? "Rendered with a sample project, model, and two agents. Discord replaces the asset keys with the images uploaded to your application."
              : "Presence is off, so this card stays hidden on Discord."
          }
        >
          <div className={cn("pb-3.5", !presence.enabled && "opacity-50")}>
            <DiscordCardPreview
              presence={{ ...presence, showProjectName }}
              mode={settings.mem.enabled ? PREVIEW_MODE : ""}
            />
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
