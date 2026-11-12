import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SIDEBAR_SURFACES, type SidebarSurface } from "./sidebarSurface";

const SURFACE_LABELS: Readonly<Record<SidebarSurface, string>> = {
  chats: "Chats",
  code: "Code",
};

/** Chats and Code split the sidebar; exactly one surface is ever shown. */
export function SidebarSurfaceSwitcher(props: {
  readonly surface: SidebarSurface;
  readonly onSurfaceChange: (surface: SidebarSurface) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Sidebar surface"
      className="w-full"
      onValueChange={(next) => {
        const value = next[0];
        if (value === "chats" || value === "code") props.onSurfaceChange(value);
      }}
      size="segmented"
      value={[props.surface]}
      variant="segmented"
    >
      {SIDEBAR_SURFACES.map((surface) => (
        <Toggle className="flex-1" key={surface} value={surface}>
          {SURFACE_LABELS[surface]}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
