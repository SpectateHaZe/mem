import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ProviderModelPicker } from "./ProviderModelPicker";

export type ComposerSubagent = {
  readonly selection: ModelSelection | null;
  readonly reportToMain: boolean;
  readonly onSelect: (selection: ModelSelection, label: string) => void;
  readonly onClear: () => void;
  readonly onReportToMainChange: (reportToMain: boolean) => void;
};

const MODES = [
  {
    reportToMain: true,
    title: "Report to main agent",
    description: "Tells the main agent you started it, and sends it the result when it's done.",
  },
  {
    reportToMain: false,
    title: "Side panel only",
    description: "Runs in the side panel. The main agent doesn't hear about it.",
  },
] as const;

type PickerProps = ComponentProps<typeof ProviderModelPicker>;

export const SubagentModelPicker = memo(function SubagentModelPicker(
  props: {
    readonly subagent: ComposerSubagent;
    readonly fallbackInstanceId: ProviderInstanceId;
  } & Pick<
    PickerProps,
    | "environmentId"
    | "disabled"
    | "instanceEntries"
    | "modelOptionsByInstance"
    | "size"
    | "getModelDisabledReason"
    | "onOpenProviderSetup"
  >,
) {
  const { subagent, fallbackInstanceId, ...pickerProps } = props;
  const { selection } = subagent;
  const modelName = (instanceId: ProviderInstanceId, model: string) => {
    const option = props.modelOptionsByInstance.get(instanceId)?.find((row) => row.slug === model);
    return option?.shortName ?? option?.name ?? model;
  };
  return (
    <ProviderModelPicker
      {...pickerProps}
      activeInstanceId={selection?.instanceId ?? fallbackInstanceId}
      model={selection?.model ?? ""}
      lockedProvider={null}
      triggerLabel={
        selection ? `Subagent: ${modelName(selection.instanceId, selection.model)}` : "Subagent"
      }
      triggerAriaLabel="Start a subagent with your next message"
      triggerClassName={cn("min-w-13", selection !== null && "text-primary")}
      onInstanceModelChange={(instanceId, model) =>
        subagent.onSelect({ instanceId, model }, modelName(instanceId, model))
      }
      effortColumn={
        <div className="flex h-full flex-col gap-1 p-2">
          <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
            Your next message starts it
          </p>
          <div role="radiogroup" aria-label="When the subagent finishes" className="contents">
            {MODES.map((mode) => (
              <button
                key={mode.title}
                type="button"
                role="radio"
                data-effort-level
                aria-checked={subagent.reportToMain === mode.reportToMain}
                className="rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent aria-checked:bg-accent"
                onClick={() => subagent.onReportToMainChange(mode.reportToMain)}
              >
                <span className="block font-medium">{mode.title}</span>
                <span className="block text-muted-foreground">{mode.description}</span>
              </button>
            ))}
          </div>
          {selection !== null ? (
            <Button className="mt-auto" variant="ghost" size="xs" onClick={subagent.onClear}>
              Cancel subagent
            </Button>
          ) : null}
        </div>
      }
    />
  );
});
