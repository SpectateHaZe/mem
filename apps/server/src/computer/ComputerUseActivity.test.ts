import { ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ComputerUseActivity from "./ComputerUseActivity.ts";

const caller = { threadId: ThreadId.make("thread-1"), projectId: ProjectId.make("project-1") };

const current = Effect.gen(function* () {
  const activity = yield* ComputerUseActivity.ComputerUseActivity;
  return Option.getOrThrow(yield* Stream.runHead(activity.changes));
});

it.effect("glows for any thread, marks the click, and lingers between calls", () =>
  Effect.gen(function* () {
    const activity = yield* ComputerUseActivity.ComputerUseActivity;
    yield* activity.screenshot(caller, { width: 1000, height: 500 });
    expect(yield* current).toEqual({ state: "inspecting", threadId: caller.threadId, point: null });

    yield* activity.act(caller, { action: "click", x: 250, y: 250 });
    expect(yield* current).toEqual({
      state: "driving",
      threadId: caller.threadId,
      point: { x: 0.25, y: 0.5 },
    });

    // A screenshot after acting keeps the agent shown as in control.
    yield* activity.screenshot(caller, { width: 1000, height: 500 });
    expect((yield* current).state).toBe("driving");

    yield* TestClock.adjust(ComputerUseActivity.COMPUTER_USE_LINGER_MS - 1);
    expect((yield* current).state).toBe("driving");
    yield* TestClock.adjust(1);
    expect((yield* current).state).toBe("hidden");
  }).pipe(Effect.provide(ComputerUseActivity.layer)),
);

it.effect("Esc stops the owning thread unless the agent just pressed Esc itself", () =>
  Effect.gen(function* () {
    const activity = yield* ComputerUseActivity.ComputerUseActivity;
    yield* activity.act(caller, { action: "key", text: "escape" });
    expect(yield* activity.stop()).toBeNull();
    expect((yield* current).state).toBe("driving");

    yield* TestClock.adjust(2_000);
    expect(yield* activity.stop()).toEqual(caller);
    expect((yield* current).state).toBe("hidden");
    expect(yield* activity.stop()).toBeNull();
  }).pipe(Effect.provide(ComputerUseActivity.layer)),
);

it("recognises the agent's own Esc only for the key action", () => {
  expect(ComputerUseActivity.pressesEscape({ action: "key", text: "Esc" })).toBe(true);
  expect(ComputerUseActivity.pressesEscape({ action: "key", text: "shift+escape" })).toBe(true);
  expect(ComputerUseActivity.pressesEscape({ action: "type", text: "esc" })).toBe(false);
  expect(ComputerUseActivity.pressesEscape({ action: "key", text: "escapex" })).toBe(false);
});
