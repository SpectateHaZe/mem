import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

/**
 * Low usage mode tells the lead to do nothing itself, so a subagent provider that was removed or
 * turned off would leave it unable to work; the mode is skipped until another model is chosen.
 */
export const subagentProviderUsable = Effect.fn("lowUsage.subagentProviderUsable")(
  function* (
    registry: Option.Option<
      Pick<ProviderInstanceRegistry.ProviderInstanceRegistry["Service"], "getInstance">
    >,
    instanceId: ProviderInstanceId,
  ) {
    // No registry (a test harness) keeps the mode as saved.
    if (Option.isNone(registry)) return true;
    const instance = yield* registry.value.getInstance(instanceId);
    if (instance === undefined) return false;
    return (yield* instance.snapshot.getSnapshot).enabled;
  },
  (effect) => effect.pipe(Effect.orElseSucceed(() => true)),
);

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
