import {
  DEFAULT_MEM_OVERSEER_SETTINGS,
  DEFAULT_MEM_QUALITY_PROMPT,
  type MemOverseerSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolvePastedPath } from "@t3tools/shared/path";
import { useRef } from "react";

import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const PACE_MODE_LABELS = { on_pace: "On pace", full: "Full" } as const;

export function MemOverseerSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["mem"]);
  const { environment, connectedEnvironments, targets, target } = useSettingsScope();
  const scopeKey = targets.map((target) => target.environmentId).join(",");
  const editedQualityPrompt = useRef(false);
  const mem = settings.mem;
  const environmentId = environment?.environmentId ?? null;
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const instanceEntries = providerInstanceEntriesFor(
    textGenerationProviders,
    settings,
    target?.projectId ?? null,
  );
  const enabledInstanceIds = new Set(
    instanceEntries
      .filter((entry) => entry.enabled && entry.isAvailable)
      .map((entry) => entry.instanceId),
  );
  const effectiveProviders = textGenerationProviders.filter((provider) =>
    enabledInstanceIds.has(provider.instanceId),
  );
  const fallbackSelection = resolveAppModelSelectionState(settings, effectiveProviders);
  const modelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries);

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
  const modelRow = (
    title: "premium model" | "economy model",
    settingId: "mem-premium-model" | "mem-economy-model",
    description: string,
    value: ModelSelection | null,
    onChange: (next: ModelSelection | null) => void,
  ) => {
    const active = value ?? fallbackSelection;
    return (
      <SettingsRow
        serverScoped
        settingKeys={["mem"]}
        {...searchableSetting(settingId)}
        description={description}
        resetAction={
          value === null ? null : (
            <SettingResetButton label={title} onClick={() => onChange(null)} />
          )
        }
        control={
          connectedEnvironments.length === 0 ? (
            <span className="text-sm text-muted-foreground">
              Connect an environment to choose a model.
            </span>
          ) : effectiveProviders.length === 0 ? (
            <span className="text-sm text-muted-foreground">
              No text generation providers available.
            </span>
          ) : (
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={active.instanceId}
              model={active.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={getCustomModelOptionsByInstance(
                settings,
                effectiveProviders,
                active.instanceId,
                active.model,
              )}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerAriaLabel={`Mem ${title}`}
              {...(value === null ? { triggerLabel: "Not set" } : {})}
              getModelDisabledReason={modelDisabledReason}
              onInstanceModelChange={(instanceId, model) => {
                const reason = modelDisabledReason(instanceId, model);
                if (reason) {
                  toastManager.add({
                    type: "error",
                    title: `Mem ${title} not saved`,
                    description: reason,
                  });
                  return;
                }
                onChange(createModelSelection(instanceId, model));
              }}
            />
          )
        }
      />
    );
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
        {...searchableSetting("mem-pace-mode")}
        description="On pace drops to the economy model when spending runs ahead of the week. Full always uses the premium model."
        control={
          <Select
            value={mem.paceMode}
            onValueChange={(value) => {
              if (value === "on_pace" || value === "full") update({ paceMode: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Spending pace">
              <SelectValue>{PACE_MODE_LABELS[mem.paceMode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              <SelectItem value="on_pace">{PACE_MODE_LABELS.on_pace}</SelectItem>
              <SelectItem value="full">{PACE_MODE_LABELS.full}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {modelRow(
        "premium model",
        "mem-premium-model",
        "The model Mem uses while spending tracks the week, and always in Full. Mem parks its tasks only when neither model is set.",
        mem.premiumModelSelection,
        (premiumModelSelection) => update({ premiumModelSelection }),
      )}
      {modelRow(
        "economy model",
        "mem-economy-model",
        "The model Mem drops to when spending runs ahead of the week. Without one, Mem stays on the premium model.",
        mem.economyModelSelection,
        (economyModelSelection) => update({ economyModelSelection }),
      )}
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
