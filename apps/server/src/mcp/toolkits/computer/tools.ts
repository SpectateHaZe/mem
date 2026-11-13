import {
  ComputerActInput,
  ComputerActResult,
  ComputerScreenshotInput,
  ComputerScreenshotResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ComputerUseActivity from "../../../computer/ComputerUseActivity.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  ComputerUseActivity.ComputerUseActivity,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ServerSettings.ServerSettingsService,
];

export const ComputerScreenshotTool = Tool.make("computer_screenshot", {
  description: "See the user's desktop as a PNG. Use its pixels as `computer_act` coordinates.",
  parameters: ComputerScreenshotInput,
  success: ComputerScreenshotResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot desktop")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ComputerActTool = Tool.make("computer_act", {
  description:
    "Control the user's real mouse and keyboard. Screenshot again to confirm each step. Never enter passwords or payment details.",
  parameters: ComputerActInput,
  success: ComputerActResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Control desktop")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerScreenshotToolkit = Toolkit.make(ComputerScreenshotTool);
export const ComputerActToolkit = Toolkit.make(ComputerActTool);
