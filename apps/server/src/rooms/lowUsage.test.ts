import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { withLowUsageInstructions } from "./lowUsage.ts";

it("names the chosen subagent model and keeps the user's message last", () => {
  const prompt = withLowUsageInstructions("Fix the bug", {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "deepseek-free",
  });
  assert.include(prompt, 'providerInstanceId "opencode" and model "deepseek-free"');
  assert.isTrue(prompt.endsWith("\n\nFix the bug"));
});
