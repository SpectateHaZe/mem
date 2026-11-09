import { createFileRoute } from "@tanstack/react-router";

import { QueuePage } from "../components/rooms/QueuePage";

export const Route = createFileRoute("/_chat/queue")({
  component: QueuePage,
});
