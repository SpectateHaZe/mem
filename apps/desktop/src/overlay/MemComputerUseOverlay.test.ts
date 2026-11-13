import type * as Electron from "electron";

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type FakeWindow = {
  alwaysOnTopCalls: Array<[boolean, string | undefined]>;
  bounds: Electron.Rectangle;
  contentProtection: Array<boolean>;
  destroyed: boolean;
  ignoreMouseEvents: Array<boolean>;
  loadedUrls: Array<string>;
  options: Electron.BrowserWindowConstructorOptions;
  shown: number;
  visibleOnAllWorkspaces: Array<[boolean, Electron.VisibleOnAllWorkspacesOptions | undefined]>;
};

type FakeDisplay = { id: number; bounds: Electron.Rectangle };

const firstDisplay: FakeDisplay = {
  id: 1,
  bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 },
};
const secondDisplay: FakeDisplay = {
  id: 2,
  bounds: { x: 0, y: -200, width: 1_440, height: 900 },
};

const mocks = vi.hoisted(() => ({
  displays: [] as Array<FakeDisplay>,
  listeners: new Map<string, Set<() => void>>(),
  windows: [] as Array<FakeWindow>,
  shortcuts: new Map<string, () => void>(),
  appWindowMessages: [] as Array<string>,
}));

vi.mock("electron", () => {
  class BrowserWindow {
    static getAllWindows() {
      return [
        {
          isDestroyed: () => false,
          webContents: { send: (channel: string) => mocks.appWindowMessages.push(channel) },
        },
      ];
    }

    readonly record: FakeWindow;

    constructor(options: Electron.BrowserWindowConstructorOptions) {
      this.record = {
        alwaysOnTopCalls: [],
        bounds: {
          x: options.x ?? 0,
          y: options.y ?? 0,
          width: options.width ?? 0,
          height: options.height ?? 0,
        },
        contentProtection: [],
        destroyed: false,
        ignoreMouseEvents: [],
        loadedUrls: [],
        options,
        shown: 0,
        visibleOnAllWorkspaces: [],
      };
      mocks.windows.push(this.record);
    }

    isDestroyed() {
      return this.record.destroyed;
    }

    destroy() {
      this.record.destroyed = true;
    }

    getBounds() {
      return this.record.bounds;
    }

    setIgnoreMouseEvents(ignore: boolean) {
      this.record.ignoreMouseEvents.push(ignore);
    }

    setContentProtection(enable: boolean) {
      this.record.contentProtection.push(enable);
    }

    setAlwaysOnTop(flag: boolean, level?: string) {
      this.record.alwaysOnTopCalls.push([flag, level]);
    }

    setVisibleOnAllWorkspaces(visible: boolean, options?: Electron.VisibleOnAllWorkspacesOptions) {
      this.record.visibleOnAllWorkspaces.push([visible, options]);
    }

    showInactive() {
      this.record.shown += 1;
    }

    loadURL(url: string) {
      this.record.loadedUrls.push(url);
      return Promise.resolve();
    }
  }

  const screen = {
    getAllDisplays: () => mocks.displays,
    getPrimaryDisplay: () =>
      mocks.displays.find((display) => display.bounds.x === 0) ?? mocks.displays[0],
    on: (event: string, listener: () => void) => {
      const listeners = mocks.listeners.get(event) ?? new Set<() => void>();
      listeners.add(listener);
      mocks.listeners.set(event, listeners);
    },
    removeListener: (event: string, listener: () => void) => {
      const listeners = mocks.listeners.get(event);
      if (!listeners) return;
      listeners.delete(listener);
      if (listeners.size === 0) mocks.listeners.delete(event);
    },
  };

  const globalShortcut = {
    register: (accelerator: string, callback: () => void) => {
      mocks.shortcuts.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator: string) => {
      mocks.shortcuts.delete(accelerator);
    },
  };

  return { BrowserWindow, globalShortcut, screen };
});

import { MemComputerUseOverlay } from "./MemComputerUseOverlay.ts";

const documentFor = (window: FakeWindow): string => {
  const url = window.loadedUrls.at(-1);
  expect(url?.startsWith("data:text/html;charset=utf-8,")).toBe(true);
  return decodeURIComponent(url!.slice("data:text/html;charset=utf-8,".length));
};

const fireDisplayChange = (event: string): void => {
  for (const listener of mocks.listeners.get(event) ?? []) listener();
};

beforeEach(() => {
  mocks.displays.length = 0;
  mocks.displays.push({ ...firstDisplay }, { ...secondDisplay });
  mocks.listeners.clear();
  mocks.windows.length = 0;
  mocks.shortcuts.clear();
  mocks.appWindowMessages.length = 0;
});

describe("MemComputerUseOverlay", () => {
  it("covers every display with a click-through window the captures cannot see", () => {
    const overlay = new MemComputerUseOverlay();
    expect(mocks.windows).toHaveLength(0);

    overlay.setState({ state: "driving", point: null });

    expect(mocks.windows).toHaveLength(2);
    const [first, second] = mocks.windows;
    expect(first!.bounds).toEqual(firstDisplay.bounds);
    expect(second!.bounds).toEqual(secondDisplay.bounds);
    for (const window of mocks.windows) {
      expect(window.options).toMatchObject({
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        movable: false,
        skipTaskbar: true,
        focusable: false,
        alwaysOnTop: true,
      });
      expect(window.ignoreMouseEvents).toEqual([true]);
      expect(window.contentProtection).toEqual([true]);
      expect(window.shown).toBe(1);
      expect(window.visibleOnAllWorkspaces).toEqual([[true, { visibleOnFullScreen: true }]]);
      // oxlint-disable-next-line t3code/no-global-process-runtime -- The host platform decides whether the level applies.
      if (process.platform === "linux") {
        expect(window.alwaysOnTopCalls).toEqual([]);
      } else {
        expect(window.alwaysOnTopCalls).toEqual([[true, "pop-up-menu"]]);
      }
    }
  });

  it("renders a static pill instead of an animation loop", () => {
    const overlay = new MemComputerUseOverlay();
    overlay.setState({ state: "driving", point: null });

    const html = documentFor(mocks.windows[0]!);
    expect(html).toContain("Mem is using your PC");
    expect(html).toContain("pointer-events: none");
    expect(html).toContain("box-shadow");
    expect(html).not.toMatch(/animation|@keyframes|requestAnimationFrame|transition:/);
  });

  it("dims the glow and swaps the pill text while inspecting", () => {
    const overlay = new MemComputerUseOverlay();
    overlay.setState({ state: "driving", point: null });
    const window = mocks.windows[0]!;
    const drivingHtml = documentFor(window);

    overlay.setState({ state: "inspecting", point: null });

    expect(mocks.windows).toHaveLength(2);
    expect(mocks.windows[0]).toBe(window);
    const inspectingHtml = documentFor(window);
    expect(inspectingHtml).toContain("Mem is checking the work");
    expect(inspectingHtml).not.toBe(drivingHtml);
    expect(inspectingHtml).toContain("rgba(255, 110, 180, 0.32)");
    expect(drivingHtml).toContain("rgba(255, 110, 180, 0.72)");
  });

  it("destroys every window and stops listening when hidden", () => {
    const overlay = new MemComputerUseOverlay();
    overlay.setState({ state: "driving", point: null });
    expect(mocks.listeners.size).toBe(3);

    overlay.setState({ state: "hidden", point: null });

    expect(mocks.windows).toHaveLength(2);
    expect(mocks.windows.every((window) => window.destroyed)).toBe(true);
    expect(mocks.listeners.size).toBe(0);
  });

  it("rebuilds while a state is active when displays change", () => {
    const overlay = new MemComputerUseOverlay();
    overlay.setState({ state: "driving", point: null });
    const [first, second] = mocks.windows;
    const loadsBefore = first!.loadedUrls.length;

    mocks.displays.push({ id: 3, bounds: { x: 1_920, y: 0, width: 1_080, height: 1_920 } });
    fireDisplayChange("display-added");
    expect(mocks.windows).toHaveLength(3);
    expect(first!.loadedUrls).toHaveLength(loadsBefore);
    expect(first!.destroyed).toBe(false);
    expect(second!.destroyed).toBe(false);
    expect(mocks.windows[2]!.bounds).toEqual({ x: 1_920, y: 0, width: 1_080, height: 1_920 });

    mocks.displays.pop();
    fireDisplayChange("display-removed");
    expect(mocks.windows[2]!.destroyed).toBe(true);

    mocks.displays[0]!.bounds = { x: -2_560, y: 0, width: 2_560, height: 1_440 };
    fireDisplayChange("display-metrics-changed");
    expect(first!.destroyed).toBe(true);
    const replacement = mocks.windows.at(-1)!;
    expect(replacement.bounds).toEqual({ x: -2_560, y: 0, width: 2_560, height: 1_440 });
  });

  it("disposes cleanly when a window was already destroyed", () => {
    const overlay = new MemComputerUseOverlay();
    overlay.setState({ state: "driving", point: null });
    mocks.windows[0]!.destroyed = true;

    expect(() => overlay.dispose()).not.toThrow();
    expect(mocks.windows.every((window) => window.destroyed)).toBe(true);
    expect(mocks.listeners.size).toBe(0);

    expect(() => overlay.dispose()).not.toThrow();
  });

  it("marks the agent's click on the display it lands on", () => {
    const overlay = new MemComputerUseOverlay();
    // The second display sits at the origin, so it is the primary one the screenshot covers.
    overlay.setState({ state: "driving", point: { x: 0.5, y: 0.25 } });
    const [first, second] = mocks.windows;
    expect(documentFor(first!)).not.toContain('id="marker"');
    expect(documentFor(second!)).toContain('id="marker" style="left:706px;top:211px"');

    overlay.setState({ state: "driving", point: { x: 0.5, y: 0.25 } });
    expect(second!.loadedUrls).toHaveLength(1);
    overlay.dispose();
  });

  it("holds Esc only while visible and forwards it to the app windows", () => {
    const overlay = new MemComputerUseOverlay();
    overlay.setState({ state: "inspecting", point: null });
    expect(documentFor(mocks.windows[0]!)).toContain("Esc to stop");

    mocks.shortcuts.get("Escape")!();
    expect(mocks.appWindowMessages).toEqual(["desktop:computer-use-stop-request"]);

    overlay.setState({ state: "hidden", point: null });
    expect(mocks.shortcuts.has("Escape")).toBe(false);
  });
});
