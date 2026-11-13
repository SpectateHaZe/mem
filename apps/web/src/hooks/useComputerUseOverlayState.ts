import type {
  DesktopComputerUseOverlayState,
  OrchestrationV2TurnItemStatus,
} from "@t3tools/contracts";
import { useEffect, useRef } from "react";

/** The fields of a turn item the overlay mapping reads; projected rows narrow to this. */
export interface ComputerUseToolItem {
  readonly runId: string | null;
  readonly status: OrchestrationV2TurnItemStatus;
  readonly type: string;
  readonly toolName?: string | null;
}

export interface ComputerUseToolRow {
  readonly item: ComputerUseToolItem;
}

const IN_FLIGHT: ReadonlySet<OrchestrationV2TurnItemStatus> = new Set([
  "pending",
  "running",
  "waiting",
]);

const ACTING_TOOL = "computer_act";
const OBSERVING_TOOL = "computer_screenshot";

// Providers report MCP tools with a server prefix: `mcp__t3-code__computer_act` (Claude),
// `t3-code_computer_act` (OpenCode). The computer tools are not in the shared T3 tool registry.
const isTool = (toolName: string | null | undefined, tool: string): boolean =>
  toolName === tool ||
  toolName?.endsWith(`__${tool}`) === true ||
  toolName?.endsWith(`_${tool}`) === true;

/**
 * `driving` while a computer-use action is in flight, `inspecting` while only a
 * screenshot is, `hidden` once the run settles or the thread has no live tool.
 */
export function computerUseOverlayState(input: {
  readonly rows: ReadonlyArray<ComputerUseToolRow>;
  readonly runId: string | null;
}): DesktopComputerUseOverlayState {
  if (input.runId === null) return "hidden";
  let observing = false;
  for (const { item } of input.rows) {
    if (item.runId !== input.runId || item.type !== "dynamic_tool") continue;
    if (!IN_FLIGHT.has(item.status)) continue;
    if (isTool(item.toolName, ACTING_TOOL)) return "driving";
    if (isTool(item.toolName, OBSERVING_TOOL)) observing = true;
  }
  return observing ? "inspecting" : "hidden";
}

/** Reports `state` to the desktop overlay; false when this client has no bridge to report to. */
function pushOverlayState(state: DesktopComputerUseOverlayState): boolean {
  const bridge = window.desktopBridge;
  if (bridge?.setComputerUseOverlayState === undefined) return false;
  try {
    void bridge.setComputerUseOverlayState(state).catch(() => undefined);
  } catch {
    // The glow is decoration; a broken bridge must not take the render down.
  }
  return true;
}

export function useComputerUseOverlayState(input: {
  readonly rows: ReadonlyArray<ComputerUseToolRow>;
  readonly runId: string | null;
}): void {
  const state = computerUseOverlayState(input);
  const sent = useRef<DesktopComputerUseOverlayState>("hidden");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the live computer-use tool onto the desktop's overlay window
  useEffect(() => {
    if (sent.current === state) return;
    if (!pushOverlayState(state)) return;
    sent.current = state;
  }, [state]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the desktop glow when the chat view unmounts
  useEffect(
    () => () => {
      if (sent.current === "hidden") return;
      sent.current = "hidden";
      pushOverlayState("hidden");
    },
    [],
  );
}
