import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import {
  evaluateLowUsageWarnings,
  formatLowUsageWarningToast,
  gatherUsageWarningAccounts,
} from "@t3tools/shared/usageLimits";
import type { AtomRegistry } from "effect/reactivity";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { environmentSummaries } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { createUsageWarningPeriodStore } from "../state/usageWarningsStore";
import { toastManager } from "./ui/toast";
import { stackedThreadToast } from "./ui/toastHelpers";

/**
 * Warns once with a toast when a provider's usage window runs low, before it is
 * exhausted. Reads only the usage snapshots the config stream already carries,
 * so no provider is polled and no WebSocket traffic is added.
 */
export function startUsageLimitWarnings(registry: AtomRegistry.AtomRegistry): () => void {
  const store = createUsageWarningPeriodStore();
  const watched = new Map<EnvironmentId, () => void>();

  const inspectConfig = (config: ServerConfig | null) => {
    const settings = getClientSettings();
    if (!settings.usageWarningsEnabled || config === null) return;
    const now = Date.now();
    const accounts = gatherUsageWarningAccounts({
      providers: config.providers,
      sources: config.usageLimitSources ?? [],
      now,
    });
    if (accounts.length === 0) return;
    const existing = store.read();
    const { warnings, warned } = evaluateLowUsageWarnings({
      accounts,
      thresholdPercent: settings.usageWarningsThresholdPercent,
      now,
      warned: existing,
    });
    if (JSON.stringify(warned) !== JSON.stringify(existing)) store.write(warned);
    for (const warning of warnings) {
      const { title, description } = formatLowUsageWarningToast({
        name: warning.name,
        windowLabel: warning.windowLabel,
        remainingPercent: warning.remainingPercent,
        resetsAtMs: warning.resetsAtMs,
        now,
      });
      toastManager.add(stackedThreadToast({ type: "warning", title, description }));
    }
  };

  const watchEnvironment = (environmentId: EnvironmentId): (() => void) =>
    registry.subscribe(serverEnvironment.configValueAtom(environmentId), inspectConfig, {
      immediate: true,
    });

  const syncEnvironments = () => {
    // Watching while disabled turns stale subscriptions into surprise warnings on re-enable.
    const active = getClientSettings().usageWarningsEnabled
      ? new Set(registry.get(environmentSummaries.environmentIdsAtom))
      : new Set<EnvironmentId>();
    for (const [environmentId, unsubscribe] of watched) {
      if (active.has(environmentId)) continue;
      unsubscribe();
      watched.delete(environmentId);
    }
    for (const environmentId of active) {
      if (!watched.has(environmentId)) watched.set(environmentId, watchEnvironment(environmentId));
    }
  };

  const unsubscribeEnvironments = registry.subscribe(
    environmentSummaries.environmentIdsAtom,
    syncEnvironments,
  );
  const unsubscribeSettings = subscribeClientSettings(syncEnvironments);
  syncEnvironments();

  return () => {
    unsubscribeSettings();
    unsubscribeEnvironments();
    for (const unsubscribe of watched.values()) unsubscribe();
    watched.clear();
  };
}
