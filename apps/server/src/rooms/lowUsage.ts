import type { ModelSelection } from "@t3tools/contracts";

/** Repeated each turn because a provider session started before the switch never saw it. */
export const withLowUsageInstructions = (text: string, subagentModel: ModelSelection) =>
  [
    "<low_usage_mode>",
    "The user turned on low usage mode for this thread. You are the lead and subagents do the work.",
    "Do not read or search files, edit code, or run commands yourself, and do not use your provider's built-in subagents.",
    `Give that work to \`delegate_task\` with target providerInstanceId "${subagentModel.instanceId}" and model "${subagentModel.model}". Delegated children see none of this conversation, so make each task complete on its own.`,
    "Keep your own turns short: plan, delegate, then combine what the subagents report. If the request needs no tools, just answer it.",
    "</low_usage_mode>",
    "",
    text,
  ].join("\n");
