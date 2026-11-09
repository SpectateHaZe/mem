import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  getMacManualUpdateNotice,
  macManualUpdateDismissedKey,
  resolveDesktopUpdateButtonAction,
} from "./desktopUpdate.logic";
import { getLocalStorageItem, writeLocalStorageValue } from "../hooks/useLocalStorage";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("hides the install action while checking for a newer release", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });
});

describe("desktop update UI helpers", () => {
  it.each(["owner/repo/extra", "owner#notes/repo", "owner/repo?tab=notes"])(
    "falls back to upstream for an invalid configured repository: %s",
    (repository) => {
      expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBe(
        "https://github.com/SpectateHaZe/mem/releases",
      );
      expect(getDesktopUpdateReleaseUrl("1.2.3", repository)).toBe(
        "https://github.com/SpectateHaZe/mem/releases/tag/v1.2.3",
      );
    },
  );
});

describe("canCheckForUpdate", () => {
  it("returns true once an update has been downloaded so newer releases can be found", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(true);
  });
});

describe("mac manual update notice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const disabledMacState = {
    ...baseState,
    enabled: false,
    status: "disabled" as const,
    currentVersion: "0.1.9",
    manualUpdate: {
      version: "0.1.10",
      releaseUrl: "https://github.com/SpectateHaZe/mem/releases/tag/v0.1.10",
    },
  };

  it("shows the release-page offer on a mac only when it is newer than the running build", () => {
    expect(getMacManualUpdateNotice(disabledMacState, "darwin")).toEqual(
      disabledMacState.manualUpdate,
    );
    expect(
      getMacManualUpdateNotice({ ...disabledMacState, currentVersion: "0.1.10" }, "darwin"),
    ).toBeNull();
    expect(
      getMacManualUpdateNotice(
        {
          ...disabledMacState,
          manualUpdate: { version: "0.1.9", releaseUrl: "https://example.com" },
        },
        "darwin",
      ),
    ).toBeNull();
  });

  it("shows nothing away from a mac, away from a disabled updater, or without an offer", () => {
    expect(getMacManualUpdateNotice(disabledMacState, "win32")).toBeNull();
    expect(getMacManualUpdateNotice(disabledMacState, null)).toBeNull();
    expect(
      getMacManualUpdateNotice({ ...disabledMacState, status: "available" }, "darwin"),
    ).toBeNull();
    const { manualUpdate: _omitted, ...withoutOffer } = disabledMacState;
    expect(getMacManualUpdateNotice(withoutOffer, "darwin")).toBeNull();
  });

  it("returns for a newer release after a version was dismissed", () => {
    const localStorageStub = createLocalStorageStub();
    vi.stubGlobal("window", { localStorage: localStorageStub });
    writeLocalStorageValue(
      macManualUpdateDismissedKey("0.1.9"),
      true,
      false,
      Schema.Boolean as Schema.Codec<boolean, boolean>,
    );

    expect(getLocalStorageItem(macManualUpdateDismissedKey("0.1.9"), Schema.Boolean)).toBe(true);
    expect(getLocalStorageItem(macManualUpdateDismissedKey("0.1.10"), Schema.Boolean)).toBeNull();
  });
});

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => {
      store.clear();
    },
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}
