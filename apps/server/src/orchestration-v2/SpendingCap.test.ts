import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { isSubscriptionBilledProvider } from "@t3tools/shared/providerBilling";

import { billableSpendUsd, localUsageDay, subscriptionUsageProviders } from "./SpendingCap.ts";
import { spendingCapHit, startsWork } from "./SpendingCapState.ts";

function provider(
  instanceId: string,
  driver: string,
  auth: ServerProvider["auth"],
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    auth,
  } as ServerProvider;
}

it("treats subscription logins as unbilled and metered logins as spending", () => {
  const subscription = provider("claude", "claudeAgent", {
    status: "authenticated",
    type: "pro",
  });
  const apiKey = provider("claude-key", "claudeAgent", {
    status: "authenticated",
    type: "apiKey",
  });
  const chatgpt = provider("codex", "codex", { status: "authenticated", type: "chatgpt" });
  const grokApiKey = provider("grok", "grok", { status: "authenticated", type: "apiKey" });
  const openCodeApiKey = provider("opencode", "opencode", {
    status: "authenticated",
    type: "apiKey",
  });
  const antigravitySubscription = provider("antigravity", "antigravity", {
    status: "authenticated",
    type: "oauth-personal",
  });
  const antigravityApiKey = provider("antigravity-key", "antigravity", {
    status: "authenticated",
    type: "gemini-api-key",
  });
  const signedOutClaude = provider("claude-signed-out", "claudeAgent", {
    status: "unauthenticated",
    type: "pro",
  });

  assert.isTrue(isSubscriptionBilledProvider(subscription));
  assert.isFalse(isSubscriptionBilledProvider(apiKey));
  assert.isTrue(isSubscriptionBilledProvider(chatgpt));
  assert.isFalse(isSubscriptionBilledProvider(grokApiKey));
  assert.isFalse(isSubscriptionBilledProvider(openCodeApiKey));
  assert.isTrue(isSubscriptionBilledProvider(antigravitySubscription));
  assert.isFalse(isSubscriptionBilledProvider(antigravityApiKey));
  assert.isFalse(isSubscriptionBilledProvider(signedOutClaude));
});

it("excludes a provider only when every authenticated login is subscription-billed", () => {
  const subscription = provider("claude", "claudeAgent", {
    status: "authenticated",
    type: "pro",
  });
  const apiKey = provider("claude-key", "claudeAgent", {
    status: "authenticated",
    type: "apiKey",
  });
  const chatgpt = provider("codex", "codex", { status: "authenticated", type: "chatgpt" });

  assert.deepEqual([...subscriptionUsageProviders([subscription])], ["claude"]);
  assert.deepEqual([...subscriptionUsageProviders([subscription, apiKey])], []);
  assert.deepEqual([...subscriptionUsageProviders([chatgpt])], ["codex"]);
});

it("counts only pay-per-use buckets toward the cap", () => {
  const buckets = [
    { provider: "claude" as const, costUsd: 12 },
    { provider: "codex" as const, costUsd: 3.5 },
  ];
  assert.equal(billableSpendUsd(buckets, new Set(["claude"])), 3.5);
  assert.equal(billableSpendUsd(buckets, new Set()), 15.5);
});

it("hits the cap at exactly the limit and never when the cap is off", () => {
  assert.equal(spendingCapHit(19.99, 20), undefined);
  assert.deepEqual(spendingCapHit(20, 20), { spentUsd: 20, capUsd: 20 });
  assert.equal(spendingCapHit(1_000, null), undefined);
});

it("uses the local calendar day around midnight UTC", () => {
  const justAfterUtcMidnight = Date.UTC(2026, 10, 9, 0, 30);
  assert.equal(localUsageDay(justAfterUtcMidnight, "UTC"), "2026-11-09");
  assert.equal(localUsageDay(justAfterUtcMidnight, "America/New_York"), "2026-11-08");
});

it("treats only run creation as starting work", () => {
  const event = (type: string) => ({ type }) as Parameters<typeof startsWork>[0][number];
  assert.isTrue(startsWork([event("thread.updated"), event("run.created")]));
  assert.isTrue(startsWork([event("run-attempt.created")]));
  assert.isFalse(startsWork([event("thread.updated")]));
});
