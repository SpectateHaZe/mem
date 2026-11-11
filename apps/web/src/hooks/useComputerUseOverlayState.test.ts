import { describe, expect, it } from "vite-plus/test";

import {
  computerUseOverlayState,
  type ComputerUseToolItem,
  type ComputerUseToolRow,
} from "./useComputerUseOverlayState";

const runId = "run:thread:thread-1:ordinal:1";

function toolRow(
  toolName: string,
  overrides: Partial<Omit<ComputerUseToolItem, "toolName">> = {},
): ComputerUseToolRow {
  return {
    item: {
      runId,
      status: "running",
      type: "dynamic_tool",
      toolName,
      ...overrides,
    },
  };
}

describe("computerUseOverlayState", () => {
  it("stays hidden without an active run", () => {
    expect(computerUseOverlayState({ rows: [toolRow("computer_act")], runId: null })).toBe(
      "hidden",
    );
  });

  it("drives while an action is in flight", () => {
    expect(computerUseOverlayState({ rows: [toolRow("computer_act")], runId })).toBe("driving");
  });

  it("inspects while only a screenshot is in flight", () => {
    expect(computerUseOverlayState({ rows: [toolRow("computer_screenshot")], runId })).toBe(
      "inspecting",
    );
  });

  it("prefers driving when an action and a screenshot are both in flight", () => {
    expect(
      computerUseOverlayState({
        rows: [toolRow("computer_screenshot"), toolRow("computer_act")],
        runId,
      }),
    ).toBe("driving");
  });

  it("ignores settled computer-use steps", () => {
    expect(
      computerUseOverlayState({
        rows: [toolRow("computer_act", { status: "completed" })],
        runId,
      }),
    ).toBe("hidden");
  });

  it("ignores computer-use steps belonging to another run", () => {
    expect(
      computerUseOverlayState({
        rows: [toolRow("computer_act", { runId: "run:other" })],
        runId,
      }),
    ).toBe("hidden");
  });

  it("ignores other tools and non-tool rows", () => {
    expect(
      computerUseOverlayState({
        rows: [
          toolRow("read_file"),
          toolRow("computer_act", { type: "command_execution" }),
          toolRow("computer_act", { runId: null }),
        ],
        runId,
      }),
    ).toBe("hidden");
  });
});
