import * as Electron from "electron";

import { COMPUTER_USE_STOP_REQUEST_CHANNEL } from "../ipc/channels.ts";

export type MemComputerUseOverlayMode = "hidden" | "driving" | "inspecting";

export interface MemComputerUseOverlayState {
  readonly state: MemComputerUseOverlayMode;
  /** Last pointer target as a fraction of the primary display. */
  readonly point: { readonly x: number; readonly y: number } | null;
}

type VisibleOverlayMode = Exclude<MemComputerUseOverlayMode, "hidden">;

const ALWAYS_ON_TOP_LEVEL = "pop-up-menu";
const STOP_ACCELERATOR = "Escape";
const MARKER_SIZE = 28;

const PILL_TEXT: Record<VisibleOverlayMode, string> = {
  driving: "Mem is using your PC · Esc to stop",
  inspecting: "Mem is checking the work · Esc to stop",
};

const HIDDEN: MemComputerUseOverlayState = { state: "hidden", point: null };

// The glow and marker are static on purpose: a repainting fullscreen gradient on every display
// would burn the GPU of the machine the agent is already driving.
const overlayHtml = (
  mode: VisibleOverlayMode,
  marker: { readonly x: number; readonly y: number } | null,
): string => {
  const inspecting = mode === "inspecting";
  const markerHtml =
    marker === null
      ? ""
      : `<div id="marker" style="left:${Math.round(marker.x - MARKER_SIZE / 2)}px;top:${Math.round(marker.y - MARKER_SIZE / 2)}px"></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="color-scheme" content="dark"><title>Mem</title><style>
* { pointer-events: none; }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
#glow {
  position: fixed;
  inset: 0;
  box-shadow:
    inset 0 0 0 2px rgba(255, 110, 180, ${inspecting ? 0.32 : 0.72}),
    inset 0 0 60px 6px rgba(255, 110, 180, ${inspecting ? 0.1 : 0.24}),
    inset 0 0 160px 40px rgba(255, 110, 180, ${inspecting ? 0.04 : 0.12});
}
#pill {
  position: fixed;
  top: 32vh;
  left: 50%;
  transform: translateX(-50%);
  padding: 7px 14px;
  border: 1px solid rgba(255, 110, 180, ${inspecting ? 0.24 : 0.45});
  border-radius: 999px;
  background: rgba(16, 16, 20, ${inspecting ? 0.6 : 0.76});
  color: #ffffff;
  font: 500 13px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  letter-spacing: 0.01em;
  white-space: nowrap;
  opacity: ${inspecting ? 0.85 : 1};
}
#marker {
  position: fixed;
  width: ${MARKER_SIZE - 6}px;
  height: ${MARKER_SIZE - 6}px;
  border: 3px solid rgba(255, 110, 180, 0.9);
  border-radius: 50%;
  background: rgba(255, 110, 180, 0.18);
  box-shadow: 0 0 0 2px rgba(16, 16, 20, 0.55);
}
</style></head><body>
<div id="glow"></div>
<div id="pill">${PILL_TEXT[mode]}</div>
${markerHtml}
</body></html>`;
};

/** The marker in a display's own coordinates, or null when the point falls on another display. */
const markerOnDisplay = (
  point: MemComputerUseOverlayState["point"],
  primary: Electron.Rectangle,
  display: Electron.Rectangle,
): { readonly x: number; readonly y: number } | null => {
  if (point === null) return null;
  const x = primary.x + point.x * primary.width - display.x;
  const y = primary.y + point.y * primary.height - display.y;
  if (x < 0 || y < 0 || x > display.width || y > display.height) return null;
  return { x, y };
};

const sameBounds = (a: Electron.Rectangle, b: Electron.Rectangle): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const dataUrl = (html: string): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

export class MemComputerUseOverlay {
  private current: MemComputerUseOverlayState = HIDDEN;
  private readonly windows = new Map<number, Electron.BrowserWindow>();
  private readonly renderedUrls = new Map<number, string>();
  private listening = false;
  private shortcutRegistered = false;

  setState(next: MemComputerUseOverlayState): void {
    if (
      next.state === this.current.state &&
      next.point?.x === this.current.point?.x &&
      next.point?.y === this.current.point?.y
    ) {
      return;
    }
    this.current = next;
    this.render();
  }

  dispose(): void {
    this.current = HIDDEN;
    this.closeWindows();
    this.stopListening();
    this.releaseShortcut();
  }

  private readonly onDisplaysChanged = (): void => {
    if (this.current.state === "hidden") return;
    this.render();
  };

  // Every app window hears the request; the renderer asks the server to stop the agent.
  private readonly onStopShortcut = (): void => {
    const overlays = new Set(this.windows.values());
    for (const window of Electron.BrowserWindow.getAllWindows()) {
      if (overlays.has(window) || window.isDestroyed()) continue;
      window.webContents.send(COMPUTER_USE_STOP_REQUEST_CHANNEL);
    }
  };

  private claimShortcut(): void {
    if (this.shortcutRegistered) return;
    // Another app may own Esc; the glow still shows and the stop button in Mem still works.
    this.shortcutRegistered = Electron.globalShortcut.register(
      STOP_ACCELERATOR,
      this.onStopShortcut,
    );
  }

  private releaseShortcut(): void {
    if (!this.shortcutRegistered) return;
    this.shortcutRegistered = false;
    Electron.globalShortcut.unregister(STOP_ACCELERATOR);
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    Electron.screen.on("display-added", this.onDisplaysChanged);
    Electron.screen.on("display-removed", this.onDisplaysChanged);
    Electron.screen.on("display-metrics-changed", this.onDisplaysChanged);
  }

  private stopListening(): void {
    if (!this.listening) return;
    this.listening = false;
    Electron.screen.removeListener("display-added", this.onDisplaysChanged);
    Electron.screen.removeListener("display-removed", this.onDisplaysChanged);
    Electron.screen.removeListener("display-metrics-changed", this.onDisplaysChanged);
  }

  private render(): void {
    const { state, point } = this.current;
    if (state === "hidden") {
      this.closeWindows();
      this.stopListening();
      this.releaseShortcut();
      return;
    }
    this.listen();
    this.claimShortcut();
    const primary = Electron.screen.getPrimaryDisplay().bounds;
    const live = new Set<number>();
    for (const display of Electron.screen.getAllDisplays()) {
      live.add(display.id);
      const url = dataUrl(overlayHtml(state, markerOnDisplay(point, primary, display.bounds)));
      const window = this.windows.get(display.id);
      if (window && !window.isDestroyed() && sameBounds(window.getBounds(), display.bounds)) {
        if (this.renderedUrls.get(display.id) !== url) this.loadWindow(display.id, window, url);
        continue;
      }
      this.closeWindow(display.id);
      this.openWindow(display, url);
    }
    for (const id of this.windows.keys()) {
      if (!live.has(id)) this.closeWindow(id);
    }
  }

  private openWindow(display: Electron.Display, url: string): void {
    const window = new Electron.BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      title: "Mem computer use",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.windows.set(display.id, window);
    window.setIgnoreMouseEvents(true);
    // Keeps the glow out of the agent's own screenshots.
    window.setContentProtection(true);
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Plain Electron window helper with no Effect runtime to inject.
    if (process.platform !== "linux") window.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
    if (typeof window.setVisibleOnAllWorkspaces === "function") {
      try {
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      } catch {}
    }
    window.showInactive();
    this.loadWindow(display.id, window, url);
  }

  private loadWindow(id: number, window: Electron.BrowserWindow, url: string): void {
    if (window.isDestroyed()) return;
    this.renderedUrls.set(id, url);
    void window.loadURL(url).catch(() => undefined);
  }

  private closeWindow(id: number): void {
    const window = this.windows.get(id);
    this.windows.delete(id);
    this.renderedUrls.delete(id);
    if (window && !window.isDestroyed()) window.destroy();
  }

  private closeWindows(): void {
    for (const id of this.windows.keys()) this.closeWindow(id);
  }
}
