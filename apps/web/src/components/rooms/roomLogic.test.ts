import { describe, expect, it } from "vite-plus/test";

import { decisionLine, validateNewRoom, withoutDecision } from "./roomLogic";

const valid = {
  title: "Sync",
  message: "Websockets?",
  rounds: 3,
  projectId: "project",
  agents: [
    { optionKey: "a", label: "Claude" },
    { optionKey: "b", label: "DeepSeek" },
  ],
};

describe("validateNewRoom", () => {
  it("accepts a complete room", () => {
    expect(validateNewRoom(valid)).toBeNull();
  });

  it.each([
    [{ ...valid, rounds: 0 }, "Rounds"],
    [{ ...valid, rounds: 2.5 }, "Rounds"],
    [{ ...valid, agents: [valid.agents[0]!, { optionKey: "b", label: "claude" }] }, "different"],
    [{ ...valid, agents: [valid.agents[0]!, { optionKey: "b", label: "Deep Seek" }] }, "spaces"],
  ])("rejects %#", (input, expected) => {
    expect(validateNewRoom(input)).toContain(expected);
  });
});

describe("decisionLine", () => {
  it("finds a decision on its own line, with or without bold", () => {
    expect(decisionLine("Long reply\nDecision: use websockets")).toBe("use websockets");
    expect(decisionLine("**Decision:** use websockets")).toBe("use websockets");
    expect(decisionLine("**Decision: use websockets**")).toBe("use websockets");
    expect(withoutDecision("Long reply\nDecision: use websockets")).toBe("Long reply");
  });

  it("ignores the word mid-sentence", () => {
    expect(decisionLine("My Decision: is pending")).toBeNull();
  });
});
