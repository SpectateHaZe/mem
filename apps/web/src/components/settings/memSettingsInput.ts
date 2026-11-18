/** A typed setting number, or null when the draft is empty, not a number, or negative. */
export const parseMemSettingNumber = (
  key: "spendingCapUsd" | "idleThresholdMinutes",
  draft: string,
): number | null => {
  const trimmed = draft.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  // The cap keeps its cents: rounding 0.4 to 0 would switch the cap off.
  if (key === "spendingCapUsd") return Math.round(value * 100) / 100;
  // The server reads 0 minutes as "never away", so Mem would silently never act.
  const minutes = Math.round(value);
  return minutes < 1 ? null : minutes;
};
