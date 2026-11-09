import * as Schema from "effect/Schema";

import { readLocalStorageValue, writeLocalStorageValue } from "../hooks/useLocalStorage";

const STORAGE_KEY = "usage-limit-warnings.v1";

/** Which reset period each provider login + window was last warned in. */
const WarnedPeriodsSchema = Schema.Record(Schema.String, Schema.String);
export type WarnedPeriods = typeof WarnedPeriodsSchema.Type;

export interface UsageWarningPeriodStore {
  read: () => WarnedPeriods;
  write: (periods: WarnedPeriods) => void;
}

/**
 * Remembers warned reset periods so a reload or reconnect does not repeat a warning.
 * Storage failures degrade to once per app session instead of once per period.
 */
export function createUsageWarningPeriodStore(): UsageWarningPeriodStore {
  let memory: WarnedPeriods = {};
  try {
    memory = readLocalStorageValue(STORAGE_KEY, {}, WarnedPeriodsSchema);
  } catch {
    memory = {};
  }
  return {
    read: () => memory,
    write: (periods) => {
      memory = periods;
      writeLocalStorageValue(STORAGE_KEY, periods, {}, WarnedPeriodsSchema);
    },
  };
}
