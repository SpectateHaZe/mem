/**
 * What the desktop glow shows: which thread is using this machine's screen, whether it is acting or
 * only looking, and where it last pointed. Recorded by the computer tools for every thread, so the
 * glow does not depend on which thread a client has open.
 */

import type { ComputerActInput, ComputerUseActivity as Activity } from "@t3tools/contracts";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/** The agent thinks between calls; the glow stays on through that gap instead of blinking. */
export const COMPUTER_USE_LINGER_MS = 20_000;
/** An Esc the agent itself typed reaches the global shortcut too; ignore stops this soon after. */
const OWN_ESCAPE_GRACE_MS = 1_500;

const HIDDEN: Activity = { state: "hidden", threadId: null, point: null };

interface ScreenSize {
  readonly width: number;
  readonly height: number;
}

/** Screenshot pixels to a fraction of the primary display, which is what the screenshot covers. */
const pointerFraction = (input: ComputerActInput, screen: ScreenSize | null): Activity["point"] => {
  if (input.x === undefined || input.y === undefined || screen === null) return null;
  if (screen.width <= 0 || screen.height <= 0) return null;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return { x: clamp(input.x / screen.width), y: clamp(input.y / screen.height) };
};

export const pressesEscape = (input: ComputerActInput): boolean =>
  input.action === "key" && /(^|\+)\s*esc(ape)?\s*$/i.test(input.text ?? "");

export class ComputerUseActivity extends Context.Service<
  ComputerUseActivity,
  {
    readonly screenshot: (
      caller: { readonly threadId: ThreadId; readonly projectId: ProjectId } | undefined,
      size: ScreenSize,
    ) => Effect.Effect<void>;
    readonly act: (
      caller: { readonly threadId: ThreadId; readonly projectId: ProjectId } | undefined,
      input: ComputerActInput,
    ) => Effect.Effect<void>;
    /** Clears the glow; returns the thread to interrupt, or null when there is none to stop. */
    readonly stop: () => Effect.Effect<{
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
    } | null>;
    readonly changes: Stream.Stream<Activity>;
  }
>()("t3/computer/ComputerUseActivity") {}

const make = Effect.gen(function* () {
  const activity = yield* SubscriptionRef.make<Activity>(HIDDEN);
  const owner = yield* Ref.make<{ threadId: ThreadId; projectId: ProjectId } | null>(null);
  const screen = yield* Ref.make<ScreenSize | null>(null);
  const lastOwnEscapeAtMs = yield* Ref.make(Number.NEGATIVE_INFINITY);
  const linger = yield* FiberHandle.make();

  const hide = Effect.gen(function* () {
    yield* Ref.set(owner, null);
    yield* SubscriptionRef.set(activity, HIDDEN);
  });

  const show = Effect.fnUntraced(function* (
    caller: { readonly threadId: ThreadId; readonly projectId: ProjectId } | undefined,
    next: (current: Activity) => Activity,
  ) {
    if (caller !== undefined) yield* Ref.set(owner, caller);
    yield* SubscriptionRef.update(activity, next);
    yield* FiberHandle.run(linger, Effect.sleep(COMPUTER_USE_LINGER_MS).pipe(Effect.andThen(hide)));
  });

  const screenshot = Effect.fn("ComputerUseActivity.screenshot")(function* (
    caller: { readonly threadId: ThreadId; readonly projectId: ProjectId } | undefined,
    size: ScreenSize,
  ) {
    yield* Ref.set(screen, size);
    // A look after an action keeps the stronger glow: the agent is still in control.
    yield* show(caller, (current) => ({
      state: current.state === "driving" ? "driving" : "inspecting",
      threadId: caller?.threadId ?? current.threadId,
      point: current.point,
    }));
  });

  const act = Effect.fn("ComputerUseActivity.act")(function* (
    caller: { readonly threadId: ThreadId; readonly projectId: ProjectId } | undefined,
    input: ComputerActInput,
  ) {
    if (pressesEscape(input)) yield* Ref.set(lastOwnEscapeAtMs, yield* Clock.currentTimeMillis);
    const point = pointerFraction(input, yield* Ref.get(screen));
    yield* show(caller, (current) => ({
      state: "driving",
      threadId: caller?.threadId ?? current.threadId,
      point: point ?? current.point,
    }));
  });

  const stop = Effect.fn("ComputerUseActivity.stop")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    if (nowMs - (yield* Ref.get(lastOwnEscapeAtMs)) < OWN_ESCAPE_GRACE_MS) return null;
    const target = yield* Ref.get(owner);
    yield* FiberHandle.clear(linger);
    yield* hide;
    return target;
  });

  return ComputerUseActivity.of({
    screenshot,
    act,
    stop,
    changes: SubscriptionRef.changes(activity),
  });
});

export const layer = Layer.effect(ComputerUseActivity, make);
