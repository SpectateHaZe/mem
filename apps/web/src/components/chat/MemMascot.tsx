import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  threadLifecycleOf,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { useState } from "react";

import { useTurnEndReaction } from "~/hooks/useTurnEndReaction";
import { BUILTIN_STICKER_SRC, MEM_MOOD_SPRITE, type MemMood } from "~/lib/memStickers";
import type { ThreadStickerAttention } from "~/lib/stickers";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";

import { MemThreadPopover } from "../mem/MemThreadPopover";
import { useMemThreadData } from "../mem/useMemThreadData";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const MASCOT_CLASS_NAME =
  // Only wide windows leave room beside the max-width chat lane and its
  // composer; below xl the mascot stays out of the layout entirely.
  "pointer-events-none absolute bottom-2 left-3 z-0 hidden select-none xl:block";

// The corner mascot. Its bob is one composited transform that observeVisibleAnimation pauses while
// hidden; on a saved thread the sprite is a button onto the thread's Mem status.
export function MemMascot(props: {
  readonly threadKey: string;
  readonly thread: EnvironmentThreadShell | null | undefined;
  readonly isWorking: boolean;
  readonly awaitingUser: ThreadStickerAttention;
  readonly failed: boolean;
  readonly className?: string;
}) {
  const reaction = useTurnEndReaction({
    isWorking: props.isWorking,
    failed: props.failed,
    resetKey: props.threadKey,
  });
  const mood: MemMood =
    props.awaitingUser !== null
      ? "needsYou"
      : props.isWorking
        ? "working"
        : reaction === "distressed"
          ? "failed"
          : reaction === "celebrate"
            ? "finished"
            : "idle";
  const [open, setOpen] = useState(false);
  const thread = props.thread ?? null;
  const threadRef = thread === null ? null : scopeThreadRef(thread.environmentId, thread.id);
  const { pendingApproval } = useMemThreadData(threadRef);
  const src = BUILTIN_STICKER_SRC[MEM_MOOD_SPRITE[mood]];

  if (thread === null || threadRef === null) {
    return (
      <div aria-hidden="true" className={cn(MASCOT_CLASS_NAME, props.className)}>
        <img
          alt=""
          className="mem-mascot-bob size-20 object-contain"
          decoding="async"
          draggable={false}
          ref={observeVisibleAnimation}
          src={src}
        />
      </div>
    );
  }

  return (
    <div className={cn(MASCOT_CLASS_NAME, props.className)}>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger
          aria-label={
            pendingApproval === null
              ? "Mem: thread status"
              : "Mem: thread status, needs your answer"
          }
          render={
            <button
              className="pointer-events-auto relative block cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              type="button"
            />
          }
        >
          <img
            alt=""
            aria-hidden="true"
            className="mem-mascot-bob size-20 object-contain"
            decoding="async"
            draggable={false}
            ref={observeVisibleAnimation}
            src={src}
          />
          {pendingApproval === null ? null : (
            <span
              aria-hidden="true"
              className="absolute right-0 top-0 size-2.5 rounded-full bg-warning ring-2 ring-background"
            />
          )}
        </PopoverTrigger>
        <PopoverPopup align="start" side="top" width="md">
          <MemThreadPopover
            lifecycle={threadLifecycleOf(thread)}
            onClose={() => setOpen(false)}
            threadRef={threadRef}
            title={thread.title}
          />
        </PopoverPopup>
      </Popover>
    </div>
  );
}
