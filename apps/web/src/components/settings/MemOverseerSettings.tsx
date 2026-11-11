import {
  DEFAULT_MEM_OVERSEER_SETTINGS,
  DEFAULT_MEM_QUALITY_PROMPT,
  type MemOverseerSettings,
} from "@t3tools/contracts";
import { resolvePastedPath } from "@t3tools/shared/path";
import { useRef } from "react";

import { DraftInput } from "../ui/draft-input";
import { Textarea } from "../ui/textarea";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function MemOverseerSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["mem"]);
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => target.environmentId).join(",");
  const editedQualityPrompt = useRef(false);
  const mem = settings.mem;

  const update = (patch: Partial<MemOverseerSettings>) =>
    updateSettings({ mem: { ...mem, ...patch } });
  const reset = (key: keyof MemOverseerSettings) =>
    updateSettings({ mem: { ...mem, [key]: DEFAULT_MEM_OVERSEER_SETTINGS[key] } });
  const commitWholeNumber = (key: "spendingCapUsd" | "idleThresholdMinutes", next: string) => {
    const draft = next.trim();
    if (draft === "") return;
    const value = Number(draft);
    if (!Number.isFinite(value) || value < 0) return;
    const whole = Math.round(value);
    update(key === "spendingCapUsd" ? { spendingCapUsd: whole } : { idleThresholdMinutes: whole });
  };

  return (
    <SettingsSection id={searchableSetting("mem-overseer").id} title="Mem overseer">
      <SettingsRow
        serverScoped
        settingKeys={["mem"]}
        {...searchableSetting("mem-enabled")}
        description="While this is on, Mem can send follow-up instructions to marked sessions on its own, and spend money doing it."
        control={
          <ScopedSwitch
            settingKeys={["mem"]}
            checked={mem.enabled}
            onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
            aria-label="Enable Mem"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["mem"]}
        {...searchableSetting("mem-spending-cap")}
        description="Reaching this cap parks every task Mem has claimed and stops it. Mem never overshoots it."
        resetAction={
          mem.spendingCapUsd !== DEFAULT_MEM_OVERSEER_SETTINGS.spendingCapUsd ? (
            <SettingResetButton label="spending cap" onClick={() => reset("spendingCapUsd")} />
          ) : null
        }
        control={
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="text-xs text-muted-foreground">
              $
            </span>
            <DraftInput
              size="sm"
              className="w-full sm:w-24"
              inputMode="numeric"
              value={String(mem.spendingCapUsd)}
              onCommit={(next) => commitWholeNumber("spendingCapUsd", next)}
              placeholder={mixed ? "Mixed" : "0"}
              aria-label="Spending cap in US dollars"
            />
          </div>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["mem"]}
        {...searchableSetting("mem-spawn-directory")}
        description="Where Mem creates a new project when no existing session fits a task. Leave empty and Mem will not spawn one."
        resetAction={
          mem.spawnDirectory !== DEFAULT_MEM_OVERSEER_SETTINGS.spawnDirectory ? (
            <SettingResetButton label="spawn directory" onClick={() => reset("spawnDirectory")} />
          ) : null
        }
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={mem.spawnDirectory}
            onCommit={(next) => update({ spawnDirectory: next.trim() })}
            normalizeDraft={resolvePastedPath}
            placeholder={mixed ? "Mixed" : "D:\\mem-projects"}
            spellCheck={false}
            aria-label="Spawn directory"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["mem"]}
        {...searchableSetting("mem-idle-threshold")}
        description="How long this machine must be untouched before Mem treats you as away."
        resetAction={
          mem.idleThresholdMinutes !== DEFAULT_MEM_OVERSEER_SETTINGS.idleThresholdMinutes ? (
            <SettingResetButton
              label="idle threshold"
              onClick={() => reset("idleThresholdMinutes")}
            />
          ) : null
        }
        control={
          <div className="flex items-center gap-2">
            <DraftInput
              size="sm"
              className="w-full sm:w-24"
              inputMode="numeric"
              value={String(mem.idleThresholdMinutes)}
              onCommit={(next) => commitWholeNumber("idleThresholdMinutes", next)}
              placeholder={mixed ? "Mixed" : "20"}
              aria-label="Idle threshold in minutes"
            />
            <span aria-hidden="true" className="text-xs text-muted-foreground">
              minutes
            </span>
          </div>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["mem"]}
        {...searchableSetting("mem-quality-prompt")}
        description="The rubric Mem judges finished work against. The placeholders {{task}}, {{acceptance}}, {{changes}}, and {{evidence}} are filled in automatically."
        resetAction={
          mixed || mem.qualityPrompt !== DEFAULT_MEM_QUALITY_PROMPT ? (
            <SettingResetButton
              label="quality bar"
              onClick={() => update({ qualityPrompt: DEFAULT_MEM_QUALITY_PROMPT })}
            />
          ) : null
        }
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          {/* Textarea owns its typography, so the rubric's mono face comes from the wrapper. */}
          <div className="font-mono">
            <Textarea
              key={`${scopeKey}:${mixed}:${mem.qualityPrompt}`}
              aria-label="Quality bar"
              rows={16}
              defaultValue={mixed ? "" : mem.qualityPrompt}
              placeholder={
                mixed
                  ? "Mixed. Enter a rubric to apply to all selected machines."
                  : DEFAULT_MEM_QUALITY_PROMPT
              }
              onChange={() => {
                editedQualityPrompt.current = true;
              }}
              onBlur={(event) => {
                const value = event.target.value;
                if (editedQualityPrompt.current && (mixed || value !== mem.qualityPrompt))
                  update({ qualityPrompt: value });
                editedQualityPrompt.current = false;
              }}
            />
          </div>
        </div>
      </SettingsRow>
      <SettingsRow
        serverScoped
        settingKeys={["mem"]}
        {...searchableSetting("mem-summary-images")}
        description="Adds screenshots of the finished work to the completion summary."
        control={
          <ScopedSwitch
            settingKeys={["mem"]}
            checked={mem.summaryWithImages}
            onCheckedChange={(checked) => update({ summaryWithImages: Boolean(checked) })}
            aria-label="Screenshot the summary"
          />
        }
      />
    </SettingsSection>
  );
}
