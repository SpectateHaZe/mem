import { MAX_COMPLETION_CHIME_VOLUME, MIN_COMPLETION_CHIME_VOLUME } from "@t3tools/contracts";
import { PlayIcon, UploadIcon, XIcon } from "lucide-react";
import { useRef, useState, type ChangeEvent, type CSSProperties } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import {
  clearCustomCompletionSound,
  completionChimeFileError,
  playCompletionChime,
  saveCustomCompletionSound,
} from "../../lib/completionChime";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function CompletionChimeSettings() {
  const enabled = useClientSettings((settings) => settings.completionChimeEnabled);
  const volume = useClientSettings((settings) => settings.completionChimeVolume);
  const customSoundName = useClientSettings((settings) => settings.completionChimeCustomSoundName);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const volumeRatio =
    (volume - MIN_COMPLETION_CHIME_VOLUME) /
    (MAX_COMPLETION_CHIME_VOLUME - MIN_COMPLETION_CHIME_VOLUME);
  const volumeSliderStyle = {
    "--settings-slider-progress": `${volumeRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - volumeRatio}rem`,
  } as CSSProperties;

  const chooseFile = () => fileInputRef.current?.click();

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const validation = completionChimeFileError(file);
    if (validation) {
      setError(validation);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await saveCustomCompletionSound(file);
    } catch {
      setError("Couldn't save that sound on this device.");
    } finally {
      setBusy(false);
    }
  };

  const clearFile = async () => {
    setError(null);
    setBusy(true);
    try {
      await clearCustomCompletionSound();
    } catch {
      setError("Couldn't remove that sound on this device.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("completion-chime")}
        description="Play a short chime when a thread's turn finishes, even while it is in the background. Applies to this device."
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => {
              void updateClientSettings({ completionChimeEnabled: checked }).catch(() => undefined);
            }}
            aria-label="Completion chime"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("completion-chime-volume")}
        description="How loud the completion chime plays."
        control={
          <div className="flex w-full items-center gap-3 sm:w-52">
            <output
              className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
              htmlFor="completion-chime-volume"
            >
              {volume}%
            </output>
            <input
              aria-label="Completion chime volume"
              className="settings-slider min-w-0 flex-1"
              disabled={!enabled}
              id="completion-chime-volume"
              max={MAX_COMPLETION_CHIME_VOLUME}
              min={MIN_COMPLETION_CHIME_VOLUME}
              onChange={(event) => {
                const next = Number(event.currentTarget.value);
                if (Number.isInteger(next)) {
                  void updateClientSettings({ completionChimeVolume: next }).catch(() => undefined);
                }
              }}
              step={5}
              style={volumeSliderStyle}
              type="range"
              value={volume}
            />
          </div>
        }
      />
      <SettingsRow
        {...searchableSetting("completion-chime-sound")}
        description="Use your own audio file instead of the default chime, up to 2 MB. It stays on this device."
        status={
          error ? (
            <span className="text-destructive">{error}</span>
          ) : customSoundName ? (
            `Using ${customSoundName}.`
          ) : (
            "Using the default chime."
          )
        }
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <input
              ref={fileInputRef}
              accept="audio/*"
              className="sr-only"
              onChange={(event) => void handleFile(event)}
              type="file"
            />
            <Button
              aria-label="Choose completion sound"
              disabled={busy}
              onClick={chooseFile}
              size="xs"
              variant="outline"
            >
              <UploadIcon />
              Choose file
            </Button>
            <Button
              aria-label="Preview completion chime"
              disabled={busy}
              onClick={() => void playCompletionChime({ force: true })}
              size="xs"
              variant="ghost"
            >
              <PlayIcon />
              Preview
            </Button>
            {customSoundName ? (
              <Button
                aria-label="Clear custom completion sound"
                disabled={busy}
                onClick={() => void clearFile()}
                size="xs"
                variant="ghost"
              >
                <XIcon />
                Clear
              </Button>
            ) : null}
          </div>
        }
      />
    </>
  );
}
