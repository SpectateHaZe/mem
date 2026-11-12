import { createFileRoute } from "@tanstack/react-router";
import { DiscordRpcSettingsPanel } from "../components/settings/DiscordRpcSettings";

export const Route = createFileRoute("/_chat/settings/discord")({
  component: DiscordRpcSettingsPanel,
});
