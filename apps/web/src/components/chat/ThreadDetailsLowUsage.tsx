import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
} from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { Switch } from "../ui/switch";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

export function ThreadDetailsLowUsage(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threads = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.lowUsageThreads,
  );
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId));
  // On but unsaved: without a model there is nothing to send subagents to, so the picker opens.
  const [choosingModel, setChoosingModel] = useState(false);

  const saved = threads.find((thread) => thread.threadId === props.threadId);
  const others = threads.filter((thread) => thread.threadId !== props.threadId);
  const entries = deriveProviderInstanceEntries(providers ?? []);
  const modelOptionsByInstance = new Map(entries.map((entry) => [entry.instanceId, entry.models]));
  const fallbackEntry = entries.find(isProviderInstancePickerReady) ?? entries[0];
  const savedInstance =
    saved && entries.some((entry) => entry.instanceId === saved.subagentModel.instanceId)
      ? entries.find((entry) => entry.instanceId === saved.subagentModel.instanceId)
      : undefined;
  const activeInstanceId = savedInstance?.instanceId ?? fallbackEntry?.instanceId;
  const savedSelection: ModelSelection | null = savedInstance && saved ? saved.subagentModel : null;
  const modelLabel = (selection: ModelSelection) => {
    const option = modelOptionsByInstance
      .get(selection.instanceId)
      ?.find((row) => row.slug === selection.model);
    const name = option?.shortName ?? option?.name ?? selection.model;
    return `${name}${selection.model.endsWith("-free") ? " (free)" : ""}`;
  };

  return (
    <ThreadDetailsSection headingId="thread-details-low-usage" title="Low usage mode">
      <div className="flex flex-col gap-2 px-1">
        <label className="flex items-center justify-between gap-2 text-xs">
          <span>Main agent only leads subagents</span>
          <Switch
            aria-label="Low usage mode"
            checked={saved !== undefined || choosingModel}
            onCheckedChange={(checked) => {
              setChoosingModel(checked);
              if (!checked) updateSettings({ lowUsageThreads: others });
            }}
          />
        </label>
        {activeInstanceId && (saved !== undefined || choosingModel) ? (
          <ProviderModelPicker
            environmentId={props.environmentId}
            activeInstanceId={activeInstanceId}
            model={savedSelection?.model ?? ""}
            lockedProvider={null}
            instanceEntries={entries}
            modelOptionsByInstance={modelOptionsByInstance}
            size="sm"
            triggerLabel={
              savedSelection ? `Subagent: ${modelLabel(savedSelection)}` : "Choose subagent model"
            }
            triggerAriaLabel="Subagent model"
            triggerClassName="w-full justify-between rounded-lg border bg-background text-sm font-normal sm:text-xs"
            open={choosingModel}
            onOpenChange={(open) => setChoosingModel(open)}
            onInstanceModelChange={(instanceId, model) => {
              setChoosingModel(false);
              updateSettings({
                lowUsageThreads: [
                  ...others,
                  { threadId: props.threadId, subagentModel: { instanceId, model } },
                ],
              });
            }}
          />
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
