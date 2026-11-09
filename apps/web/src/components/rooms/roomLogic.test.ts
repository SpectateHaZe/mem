import type { GoalQueue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decisionLine, queueAlerts, validateNewRoom, withoutDecision } from "./roomLogic";

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

describe("queueAlerts", () => {
  const queue = (status: GoalQueue["goals"][number]["status"], note?: string) =>
    ({
      paused: note !== undefined,
      ...(note === undefined ? {} : { note }),
      goals: [{ id: "g", projectId: "p", text: "Ship it", attempts: 0, status }],
    }) as unknown as GoalQueue;

  it("stays quiet about the first snapshot and unchanged goals", () => {
    expect(queueAlerts(undefined, queue("done"))).toEqual([]);
    expect(queueAlerts(queue("done"), queue("done"))).toEqual([]);
  });

  it("reports finished and failed goals", () => {
    expect(queueAlerts(queue("running"), queue("done"))[0]?.title).toBe("Queue goal finished");
    expect(queueAlerts(queue("running"), queue("failed"))[0]?.title).toBe("Queue goal failed");
  });

  it("reports the spending cap but not a manual pause", () => {
    expect(queueAlerts(queue("pending"), queue("pending", "Cap reached."))[0]?.description).toBe(
      "Cap reached.",
    );
    expect(queueAlerts(queue("pending"), queue("pending", "Paused."))).toEqual([]);
  });
});
