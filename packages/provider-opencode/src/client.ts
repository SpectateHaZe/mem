import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OpenCodeSettings } from "./settings.ts";

const apiKeyField = (name: string, source: string) => ({
  name,
  label: `${source} API key`,
  description: `Adds ${source} models to the model menu.`,
  placeholder: "Paste API key",
  sensitive: true,
});

export const openCodeClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("opencode"),
  label: "OpenCode",
  acpRegistryAgentIds: ["opencode", "opencode-v2"],
  settingsSchema: OpenCodeSettings,
  // Names OpenCode reads for each source, from models.dev. Other sources: Environment variables.
  environmentFields: [
    apiKeyField("OPENCODE_API_KEY", "OpenCode Zen and Go"),
    apiKeyField("ANTHROPIC_API_KEY", "Anthropic"),
    apiKeyField("OPENAI_API_KEY", "OpenAI"),
    apiKeyField("GEMINI_API_KEY", "Google Gemini"),
    apiKeyField("DEEPSEEK_API_KEY", "DeepSeek"),
    apiKeyField("OPENROUTER_API_KEY", "OpenRouter"),
    apiKeyField("XAI_API_KEY", "xAI"),
    apiKeyField("GROQ_API_KEY", "Groq"),
    apiKeyField("MISTRAL_API_KEY", "Mistral"),
    apiKeyField("ZHIPU_API_KEY", "Z.AI"),
    apiKeyField("MOONSHOT_API_KEY", "Moonshot"),
  ],
  icon: {
    viewBox: "0 0 32 40",
    fill: { light: "#211E1E", dark: "#F1ECEC" },
    paths: [
      { d: "M24 32H8V16H24V32Z", fill: { light: "#CFCECD", dark: "#4B4646" } },
      { d: "M24 8H8V32H24V8ZM32 40H0V0H32V40Z" },
    ],
  },
});
