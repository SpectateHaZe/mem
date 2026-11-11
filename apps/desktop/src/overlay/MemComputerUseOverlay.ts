import * as Electron from "electron";

export type MemComputerUseOverlayState = "hidden" | "driving" | "inspecting";

type VisibleOverlayState = Exclude<MemComputerUseOverlayState, "hidden">;

const ALWAYS_ON_TOP_LEVEL = "pop-up-menu";

const PILL_TEXT: Record<VisibleOverlayState, string> = {
  driving: "Mem is using your PC",
  inspecting: "Mem is checking the work",
};

// The glow is static on purpose: a repainting fullscreen gradient on every display
// would burn the GPU of the machine the agent is already driving.
const overlayHtml = (state: VisibleOverlayState): string => {
  const inspecting = state === "inspecting";
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
</style></head><body>
<div id="glow"></div>
<div id="pill">${PILL_TEXT[state]}</div>
</body></html>`;
};

const sameBounds = (a: Electron.Rectangle, b: Electron.Rectangle): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const dataUrl = (html: string): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

export class MemComputerUseOverlay {
  private state: MemComputerUseOverlayState = "hidden";
  private readonly windows = new Map<number, Electron.BrowserWindow>();
  private listening = false;
  private renderedUrl: string | undefined;

  setState(state: MemComputerUseOverlayState): void {
    if (state === this.state) return;
    this.state = state;
    this.render();
  }

  dispose(): void {
    this.state = "hidden";
    this.renderedUrl = undefined;
    this.closeWindows();
    this.stopListening();
  }

  private readonly onDisplaysChanged = (): void => {
    if (this.state === "hidden") return;
    this.render();
  };

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
    const state = this.state;
    if (state === "hidden") {
      this.renderedUrl = undefined;
      this.closeWindows();
      this.stopListening();
      return;
    }
    this.listen();
    const url = dataUrl(overlayHtml(state));
    const reload = url !== this.renderedUrl;
    this.renderedUrl = url;
    const displays = Electron.screen.getAllDisplays();
    const live = new Set<number>();
    for (const display of displays) {
      live.add(display.id);
      const window = this.windows.get(display.id);
      if (window && !window.isDestroyed() && sameBounds(window.getBounds(), display.bounds)) {
        if (reload) this.loadWindow(window, url);
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
    window.setContentProtection(true);
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Plain Electron window helper with no Effect runtime to inject.
    if (process.platform !== "linux") window.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
    if (typeof window.setVisibleOnAllWorkspaces === "function") {
      try {
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      } catch {}
    }
    window.showInactive();
    this.loadWindow(window, url);
  }

  private loadWindow(window: Electron.BrowserWindow, url: string): void {
    if (window.isDestroyed()) return;
    void window.loadURL(url).catch(() => undefined);
  }

  private closeWindow(id: number): void {
    const window = this.windows.get(id);
    this.windows.delete(id);
    if (window && !window.isDestroyed()) window.destroy();
  }

  private closeWindows(): void {
    for (const id of this.windows.keys()) this.closeWindow(id);
  }
}
