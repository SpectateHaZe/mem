import { assert } from "@effect/vitest";
import { GROK_COST_USD_TICKS_PER_DOLLAR } from "@t3tools/provider-grok/testing";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertMultiTurnOutput } from "./codex_output.ts";
import { projectionFor } from "../shared.ts";

export function assertMultiTurnGrokOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertMultiTurnOutput(result, transcript);

  const projection = projectionFor(result, transcript.scenario);
  // Grok's turn_completed samples arrive alongside turn settlement; each run thread carries its run.
  const billedCost = projection.providerThreads.reduce(
    (total, thread) => total + (thread.sessionCost?.amount ?? 0),
    0,
  );
  assert.equal(
    projection.providerThreads.every((thread) => thread.sessionCost?.currency === "USD"),
    true,
  );
  assert.closeTo(billedCost, (142_990_400 + 147_838_800) / GROK_COST_USD_TICKS_PER_DOLLAR, 1e-9);
}
