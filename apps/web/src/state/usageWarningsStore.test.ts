import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createUsageWarningPeriodStore } from "./usageWarningsStore";

const throwingStorage = {
  get length() {
    return 0;
  },
  clear() {},
  getItem() {
    throw new Error("denied");
  },
  key() {
    return null;
  },
  removeItem() {},
  setItem() {
    throw new Error("denied");
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usage warning period store", () => {
  it("round trips warned periods through storage", () => {
    const store = createUsageWarningPeriodStore();
    const periods = { "codex:primary:seven_day": "iso:2026-09-05T14:00:00.000Z" };
    store.write(periods);
    expect(createUsageWarningPeriodStore().read()).toEqual(
      expect.objectContaining(Object.fromEntries(Object.entries(periods))),
    );
  });

  it("degrades to memory when storage is unavailable", () => {
    vi.stubGlobal("window", { localStorage: throwingStorage });
    const store = createUsageWarningPeriodStore();
    const periods = { "claudeAgent:claude:five_hour": "day:2026-09-03" };
    expect(() => store.write(periods)).not.toThrow();
    expect(store.read()).toEqual(periods);
    // A later store cannot trust memory alone; it starts empty instead of throwing.
    expect(createUsageWarningPeriodStore().read()).toEqual({});
  });
});
