import type { CoworkSession } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  coworkDecisionSummary,
  coworkHasExtraDetails,
  coworkPhaseLabel,
  coworkTurnDetails,
  coworkTurnSummary,
  decisionLine,
  defaultCoworkAgents,
  validateCoworkSetup,
  withoutDecision,
} from "./coworkLogic";

const valid = {
  message: "Compare websockets vs SSE",
  rounds: 2,
  agents: [
    { optionKey: "a", label: "Claude" },
    { optionKey: "b", label: "Codex" },
  ],
};

describe("validateCoworkSetup", () => {
  it("accepts a complete setup", () => {
    expect(validateCoworkSetup(valid)).toBeNull();
  });

  it.each([
    [{ ...valid, rounds: 0 }, "Rounds"],
    [{ ...valid, rounds: 11 }, "Rounds"],
    [{ ...valid, rounds: 2.5 }, "Rounds"],
    [{ ...valid, agents: [valid.agents[0]!] }, "at least 2"],
    [{ ...valid, agents: [valid.agents[0]!, { optionKey: "b", label: "claude" }] }, "different"],
    [{ ...valid, agents: [valid.agents[0]!, { optionKey: "b", label: "Codex 2" }] }, "spaces"],
    [{ ...valid, message: "   " }, "topic"],
  ])("rejects %#", (input, expected) => {
    expect(validateCoworkSetup(input)).toContain(expected);
  });
});

describe("defaultCoworkAgents", () => {
  it("prefers distinct providers and avoids duplicate mention names", () => {
    const agents = defaultCoworkAgents([
      {
        key: "p1::a",
        label: "Sonnet",
        description: "P1 · Sonnet",
        providerInstanceId: "p1",
        modelSelection: { instanceId: "p1" as never, model: "a" },
      },
      {
        key: "p1::b",
        label: "Opus",
        description: "P1 · Opus",
        providerInstanceId: "p1",
        modelSelection: { instanceId: "p1" as never, model: "b" },
      },
      {
        key: "p2::c",
        label: "Sonnet",
        description: "P2 · Sonnet",
        providerInstanceId: "p2",
        modelSelection: { instanceId: "p2" as never, model: "c" },
      },
    ]);
    expect(agents.map((a) => a.optionKey)).toEqual(["p1::a", "p2::c"]);
    expect(agents.map((a) => a.label)).toEqual(["Sonnet", "Sonnet-2"]);
  });
});

describe("decisionLine", () => {
  it("extracts and strips a Decision line", () => {
    expect(decisionLine("Long reply\nDecision: use websockets")).toBe("use websockets");
    expect(decisionLine("**Decision:** use websockets")).toBe("use websockets");
    expect(withoutDecision("Long reply\nDecision: use websockets")).toBe("Long reply");
  });

  it("ignores mid-sentence occurrences", () => {
    expect(decisionLine("My Decision: is pending")).toBeNull();
  });
});

describe("cowork status helpers", () => {
  const session = {
    phase: "thinking",
    currentRound: 1,
    maxRounds: 2,
    participants: [{ status: "done" }, { status: "thinking" }],
    transcript: [{ kind: "deliberation", text: "Final take" }],
  } as unknown as CoworkSession;

  it("formats phase label and decision summary", () => {
    expect(coworkPhaseLabel(session)).toBe("Thinking (1/2)");
    expect(coworkDecisionSummary({ ...session, phase: "decided", decision: "Ship it" })).toBe(
      "Ship it",
    );
    expect(coworkDecisionSummary({ ...session, phase: "decided" })).toBe("Final take");
  });
});

describe("cowork turn summaries", () => {
  it("prefers explicit user summary and strips it from details", () => {
    const msg = {
      kind: "thought" as const,
      summary: "Use single-flight promise for refresh.",
      text: "Here is the detailed analysis.\nDecision: Single-flight promise",
    };
    expect(coworkTurnSummary(msg)).toBe("Use single-flight promise for refresh.");
    expect(coworkTurnDetails(msg)).toBe("Here is the detailed analysis.");
    expect(coworkHasExtraDetails(msg)).toBe(true);
  });

  it("extracts inline For you line or condenses long markdown fallback", () => {
    expect(
      coworkTurnSummary({
        kind: "deliberation",
        text: "For you: Retry only on 401.\n## Full notes\nMore technical points.",
      }),
    ).toBe("Retry only on 401.");

    const longFallback = coworkTurnSummary({
      kind: "thought",
      text: "## Plan\n```ts\nconst longCode = 123;\n```\n- First use a single mutex for token refresh. Second add jittered retries when the upstream endpoint returns 503 for longer than two seconds across multiple tabs.",
    });
    expect(longFallback).toBe("First use a single mutex for token refresh.");
    expect(longFallback.length).toBeLessThanOrEqual(221);
  });
});
