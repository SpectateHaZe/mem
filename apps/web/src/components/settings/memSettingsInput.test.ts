import { describe, expect, it } from "vite-plus/test";

import { parseMemSettingNumber } from "./memSettingsInput";

describe("parseMemSettingNumber", () => {
  it("keeps the spending cap's cents", () => {
    expect(parseMemSettingNumber("spendingCapUsd", "2.5")).toBe(2.5);
    expect(parseMemSettingNumber("spendingCapUsd", "0.4")).toBe(0.4);
    expect(parseMemSettingNumber("spendingCapUsd", "1.005")).toBe(1);
  });

  it("rounds the idle threshold to whole minutes", () => {
    expect(parseMemSettingNumber("idleThresholdMinutes", "20.6")).toBe(21);
  });

  it("ignores empty, non-numeric and negative drafts", () => {
    for (const draft of ["", "  ", "abc", "-1"]) {
      expect(parseMemSettingNumber("spendingCapUsd", draft)).toBeNull();
    }
  });
});
