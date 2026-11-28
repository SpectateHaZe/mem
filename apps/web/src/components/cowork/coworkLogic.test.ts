import type { CoworkSession, ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addCoworkPeer,
  coworkDecisionSummary,
  coworkPhaseLabel,
  coworkTurnSummary,
  validateCoworkSetup,
} from "./coworkLogic";

const valid = {
  message: "Compare websockets vs SSE",
  rounds: 2,
  agents: [{ label: "Claude" }, { label: "Codex" }],
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
    [{ ...valid, agents: [valid.agents[0]!, { label: "claude" }] }, "different"],
    [{ ...valid, agents: [valid.agents[0]!, { label: "Codex 2" }] }, "spaces"],
    [{ ...valid, message: "   " }, "topic"],
  ])("rejects %#", (input, expected) => {
    expect(validateCoworkSetup(input)).toContain(expected);
  });
});

describe("addCoworkPeer", () => {
  it("keeps the session's full model selection and avoids duplicate mention names", () => {
    const session: ModelSelection = {
      instanceId: "p1" as never,
      model: "opus",
      options: [{ id: "effort", value: "high" }],
    } as never;
    const options = [
      {
        key: "p1::opus",
        label: "Opus",
        description: "P1 · Opus",
        providerInstanceId: "p1",
        modelSelection: { instanceId: "p1" as never, model: "opus" },
      },
    ];
    const peers = addCoworkPeer(addCoworkPeer([], session, options), session, options);
    expect(peers.map((peer) => peer.label)).toEqual(["Opus", "Opus-2"]);
    expect(peers.map((peer) => peer.key)).toEqual([0, 1]);
    expect(peers[1]?.modelSelection).toBe(session);
    expect(
      addCoworkPeer([], { instanceId: "p2" as never, model: "gpt 5" }, options)[0]?.label,
    ).toBe("gpt-5");
  });
});

describe("cowork status helpers", () => {
  const session = {
    mode: "brainstorm",
    phase: "thinking",
    currentRound: 1,
    maxRounds: 2,
    participants: [{ status: "done" }, { status: "thinking" }],
    transcript: [{ kind: "deliberation", text: "Final take" }],
  } as unknown as CoworkSession;

  it("formats phase label and decision summary", () => {
    expect(coworkPhaseLabel(session)).toBe("Thinking (1/2)");
    expect(coworkPhaseLabel({ ...session, phase: "deliberating", mode: "code" })).toBe(
      "Building 1/2",
    );
    expect(coworkDecisionSummary({ ...session, phase: "decided", decision: "Ship it" })).toBe(
      "Ship it",
    );
    expect(coworkDecisionSummary({ ...session, phase: "decided" })).toBe("Final take");
  });
});

describe("cowork turn summaries", () => {
  it("prefers an explicit user summary", () => {
    expect(
      coworkTurnSummary({
        kind: "thought",
        summary: "Use single-flight promise for refresh.",
        text: "Here is the detailed analysis.\nDecision: Single-flight promise",
      }),
    ).toBe("Use single-flight promise for refresh.");
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
    expect(coworkTurnSummary({ kind: "deliberation", text: "Looks right.\nStance: agree" })).toBe(
      "Looks right.",
    );
  });
});
