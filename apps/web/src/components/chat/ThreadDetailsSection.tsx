import * as Schema from "effect/Schema";
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_CHEVRON_CLASS } from "./threadDetailsPanelStyles";

export function ThreadDetailsSection({
  headingId,
  title,
  actions,
  summary,
  separated = true,
  showHeading = true,
  children,
  ...props
}: Omit<ComponentProps<"section">, "className" | "style" | "title" | "aria-labelledby"> & {
  headingId: string;
  title: string;
  actions?: ReactNode;
  /**
   * Given, the heading toggles the section, which starts collapsed and is remembered per section.
   * The summary stays beside the title. Its body must render something, or the open section hides.
   */
  summary?: ReactNode;
  separated?: boolean;
  showHeading?: boolean;
}) {
  const collapsible = summary !== undefined;
  const [open, setOpen] = useLocalStorage(
    `t3code.threadDetailsSection.${headingId}`,
    false,
    Schema.Boolean,
  );
  const expanded = !collapsible || open;
  const headingVisible = collapsible || showHeading;
  return (
    <section
      {...props}
      aria-labelledby={headingVisible ? headingId : undefined}
      aria-label={headingVisible ? undefined : title}
      // A row can still render nothing (a fresh draft quiets Git actions), so an empty section
      // collapses, and a divider only follows a section that has content.
      className={cn(
        expanded ? "px-2 pt-2 pb-2.5" : "px-2 py-1",
        "has-[>div:last-child:empty]:hidden",
        separated && "border-border/65 [section:not(:has(>div:last-child:empty))~&]:border-t",
      )}
    >
      <div
        className={cn(
          "flex min-h-8 min-w-0 items-center justify-between gap-2 px-2.5",
          expanded && "mb-1",
          !headingVisible && "hidden",
        )}
      >
        <h3 className="flex min-w-0 flex-1 text-2xs font-medium text-muted-foreground select-none">
          {collapsible ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="-mx-1 flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 text-start outline-none hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span id={headingId} className="min-w-0 truncate">
                {title}
              </span>
              <span className="ms-auto flex shrink-0 items-center gap-1.5 font-normal tabular-nums">
                {summary}
              </span>
              <ChevronDownIcon
                aria-hidden
                className={cn("size-3.5 shrink-0", !open && "-rotate-90")}
              />
            </button>
          ) : (
            <span id={headingId} className="min-w-0 truncate">
              {title}
            </span>
          )}
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {expanded ? (
        collapsible ? (
          <div data-thread-details-section-body>{children}</div>
        ) : (
          children
        )
      ) : null}
    </section>
  );
}

/** Reveals a section's finished items below its live ones. */
export function ThreadDetailsEarlierToggle({
  count,
  shown,
  onToggle,
}: {
  readonly count: number;
  readonly shown: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <ThreadDetailsControl part="row" tone="muted" aria-expanded={shown} onClick={onToggle}>
      <ChevronDownIcon
        aria-hidden
        className={cn(THREAD_DETAILS_PANEL_CHEVRON_CLASS, !shown && "-rotate-90")}
      />
      {shown ? "Hide earlier" : `Show ${count} earlier`}
    </ThreadDetailsControl>
  );
}
