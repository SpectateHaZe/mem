import {
  HandActInput,
  HandActResult,
  HandRunInput,
  HandRunResult,
  HandScreenshotInput,
  HandScreenshotResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as HandHelper from "../../../lendAHand/HandHelper.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  HandHelper.HandHelper,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];

/** Lend a Hand: only the chat the user connected with a hand code can reach the other PC. */
const HandRunTool = Tool.make("hand_run", {
  description:
    "Run a command on the PC of the person this chat is helping (Lend a hand). Explain what you run and why.",
  parameters: HandRunInput,
  success: HandRunResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Run on their PC")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const HandScreenshotTool = Tool.make("hand_screenshot", {
  description: "See the helped person's screen as a PNG. Its pixels are `hand_act` coordinates.",
  parameters: HandScreenshotInput,
  success: HandScreenshotResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot their PC")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const HandActTool = Tool.make("hand_act", {
  description:
    "Use the helped person's mouse and keyboard. Never enter passwords or payment details.",
  parameters: HandActInput,
  success: HandActResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Control their PC")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const HandToolkit = Toolkit.make(HandRunTool, HandActTool);
export const HandScreenshotToolkit = Toolkit.make(HandScreenshotTool);
