import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { modelOptions } from "../rooms/roomLogic";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
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
  // On but unsaved until a model is picked: without one there is nothing to send subagents to.
  const [choosingModel, setChoosingModel] = useState(false);

  const saved = threads.find((thread) => thread.threadId === props.threadId);
  const options = modelOptions(providers ?? []);
  const selectedKey = options.find(
    (option) =>
      option.modelSelection.instanceId === saved?.subagentModel.instanceId &&
      option.modelSelection.model === saved?.subagentModel.model,
  )?.key;
  const others = threads.filter((thread) => thread.threadId !== props.threadId);

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
        {saved !== undefined || choosingModel ? (
          <Select
            defaultOpen={saved === undefined}
            value={selectedKey ?? null}
            onValueChange={(key) => {
              const option = options.find((candidate) => candidate.key === key);
              if (!option) return;
              setChoosingModel(false);
              updateSettings({
                lowUsageThreads: [
                  ...others,
                  { threadId: props.threadId, subagentModel: option.modelSelection },
                ],
              });
            }}
          >
            <SelectTrigger size="sm" aria-label="Subagent model">
              <SelectValue placeholder="Choose subagent model">
                {options.find((option) => option.key === selectedKey)?.description}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {options.map((option) => (
                <SelectItem key={option.key} value={option.key}>
                  {option.description}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
