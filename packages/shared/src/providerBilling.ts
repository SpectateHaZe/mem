import type { ServerProvider } from "@t3tools/contracts";

/** Auth types that bill each call rather than drawing on a subscription plan. */
const METERED_CLAUDE_AUTH_TYPES: ReadonlySet<string> = new Set([
  "apiKey",
  "bedrock",
  "customEndpoint",
]);

/** Subscription plans have no marginal cost, so their usage must not be shown as spend. */
export function isSubscriptionBilledProvider(
  provider: Pick<ServerProvider, "driver" | "auth">,
): boolean {
  if (provider.auth.status !== "authenticated") return false;
  switch (provider.driver) {
    case "claudeAgent":
      return provider.auth.type !== undefined && !METERED_CLAUDE_AUTH_TYPES.has(provider.auth.type);
    case "codex":
      return provider.auth.subscriptionSharing === true || provider.auth.type === "chatgpt";
    case "antigravity":
      return provider.auth.type === "oauth-personal" || provider.auth.type === "oauth-business";
    default:
      return false;
  }
}
