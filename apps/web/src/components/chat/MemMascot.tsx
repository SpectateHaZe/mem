import { useTurnEndReaction } from "~/hooks/useTurnEndReaction";
import { BUILTIN_STICKER_SRC, MEM_MOOD_SPRITE, type MemMood } from "~/lib/memStickers";
import type { ThreadStickerAttention } from "~/lib/stickers";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";

/**
 * The product's mascot, parked in the corner of the chat lane. The bob is a
 * single composited transform owned by index.css; observeVisibleAnimation
 * pauses it while the window is hidden and never starts it under reduced
 * motion.
 */
export function MemMascot(props: {
  readonly threadKey: string;
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

  return (
    <div
      aria-hidden="true"
      className={cn(
        // Only wide windows leave room beside the max-width chat lane and its
        // composer; below xl the mascot stays out of the layout entirely.
        "pointer-events-none absolute bottom-2 left-3 z-0 hidden select-none xl:block",
        props.className,
      )}
    >
      <img
        alt=""
        className="mem-mascot-bob size-20 object-contain"
        decoding="async"
        draggable={false}
        ref={observeVisibleAnimation}
        src={BUILTIN_STICKER_SRC[MEM_MOOD_SPRITE[mood]]}
      />
    </div>
  );
}
