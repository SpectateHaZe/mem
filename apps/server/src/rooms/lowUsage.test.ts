import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { subagentProviderUsable, withLowUsageInstructions } from "./lowUsage.ts";

it("names the chosen subagent model and keeps the user's message last", () => {
  const prompt = withLowUsageInstructions("Fix the bug", {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "deepseek-free",
  });
  assert.include(prompt, 'providerInstanceId "opencode" and model "deepseek-free"');
  assert.isTrue(prompt.endsWith("\n\nFix the bug"));
});

const registry = (instance: { enabled: boolean } | undefined) =>
  Option.some({
    getInstance: () =>
      Effect.succeed(
        instance === undefined
          ? undefined
          : { snapshot: { getSnapshot: Effect.succeed({ enabled: instance.enabled }) } },
      ),
  } as never);
const opencode = ProviderInstanceId.make("opencode");

it.effect("drops low usage mode while its subagent provider is removed or off", () =>
  Effect.gen(function* () {
    assert.isTrue(yield* subagentProviderUsable(registry({ enabled: true }), opencode));
    assert.isFalse(yield* subagentProviderUsable(registry({ enabled: false }), opencode));
    assert.isFalse(yield* subagentProviderUsable(registry(undefined), opencode));
    assert.isTrue(yield* subagentProviderUsable(Option.none(), opencode));
  }),
);
