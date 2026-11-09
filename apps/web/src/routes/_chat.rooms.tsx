import { createFileRoute } from "@tanstack/react-router";

import { RoomsPage } from "../components/rooms/RoomsPage";

export const Route = createFileRoute("/_chat/rooms")({
  component: RoomsPage,
});
