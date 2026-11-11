import * as Effect from "effect/Effect";
import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

const fake = vi.hoisted(() => ({
  constructions: 0,
  disposals: 0,
  states: [] as Array<string>,
  failConstruction: false,
  failSetState: false,
}));

vi.mock("./MemComputerUseOverlay.ts", () => ({
  MemComputerUseOverlay: class {
    constructor() {
      fake.constructions += 1;
      if (fake.failConstruction) throw new Error("no display available");
    }

    setState(state: string) {
      if (fake.failSetState) throw new Error("window creation failed");
      fake.states.push(state);
    }

    dispose() {
      fake.disposals += 1;
    }
  },
}));

import { COMPUTER_USE_OVERLAY_STATE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { installComputerUseOverlay } from "./DesktopComputerUseOverlay.ts";

type Handlers = Map<string, DesktopIpc.DesktopIpcHandleListener>;

const event = { sender: { id: 1 } };

const layerTest = (handlers: Handlers) =>
  DesktopIpc.layer({
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  });

const send = (handlers: Handlers, raw: unknown) =>
  Effect.promise(() =>
    Promise.resolve(handlers.get(COMPUTER_USE_OVERLAY_STATE_CHANNEL)!(event, raw)),
  );

beforeEach(() => {
  fake.constructions = 0;
  fake.disposals = 0;
  fake.states.length = 0;
  fake.failConstruction = false;
  fake.failSetState = false;
});

it.effect("creates one overlay on the first visible state and disposes it with the scope", () => {
  const handlers: Handlers = new Map();
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* installComputerUseOverlay();

        yield* send(handlers, "hidden");
        expect(fake.constructions).toBe(0);

        yield* send(handlers, "driving");
        expect(fake.constructions).toBe(1);
        expect(fake.states).toEqual(["driving"]);

        yield* send(handlers, "inspecting");
        expect(fake.constructions).toBe(1);
        expect(fake.states).toEqual(["driving", "inspecting"]);

        yield* send(handlers, "hidden");
        expect(fake.states).toEqual(["driving", "inspecting", "hidden"]);

        yield* Effect.promise(() =>
          expect(
            Promise.resolve(handlers.get(COMPUTER_USE_OVERLAY_STATE_CHANNEL)!(event, "visible")),
          ).rejects.toBeDefined(),
        );
        expect(fake.states).toHaveLength(3);
      }).pipe(Effect.provide(layerTest(handlers))),
    );

    expect(fake.disposals).toBe(1);
    expect(handlers.size).toBe(0);
  });
});

it.effect("keeps the app running when the overlay cannot create or update its windows", () =>
  Effect.gen(function* () {
    const handlers: Handlers = new Map();

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* installComputerUseOverlay();

        fake.failConstruction = true;
        yield* send(handlers, "driving");
        expect(fake.constructions).toBe(1);
        expect(fake.states).toEqual([]);
        expect(fake.disposals).toBe(0);

        fake.failConstruction = false;
        yield* send(handlers, "driving");
        expect(fake.constructions).toBe(2);
        expect(fake.states).toEqual(["driving"]);

        fake.failSetState = true;
        yield* send(handlers, "inspecting");
        expect(fake.states).toEqual(["driving"]);
        expect(fake.disposals).toBe(1);

        yield* send(handlers, "hidden");
        expect(fake.constructions).toBe(2);
      }).pipe(Effect.provide(layerTest(handlers))),
    );

    expect(fake.disposals).toBe(1);
  }),
);
