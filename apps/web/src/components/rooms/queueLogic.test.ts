import type { GoalQueue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { queueAlerts } from "./queueLogic";

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
