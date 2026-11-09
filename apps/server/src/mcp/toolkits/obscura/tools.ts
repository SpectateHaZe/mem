import { ObscuraFetchInput, ObscuraFetchResult, OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ObscuraFetchTool = Tool.make("obscura_fetch", {
  description:
    "Read a web page, running its JavaScript, in Mem's lightweight headless browser. Respects robots.txt.",
  parameters: ObscuraFetchInput,
  success: ObscuraFetchResult,
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerSettings.ServerSettingsService,
    ServerConfig.ServerConfig,
  ],
})
  .annotate(Tool.Title, "Fetch page")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ObscuraToolkit = Toolkit.make(ObscuraFetchTool);
