import { ImagePlusIcon, UploadIcon, XIcon } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useStickerImage } from "../../hooks/useStickerImage";
import { BUILTIN_STICKER_LABELS, BUILTIN_STICKER_SRC } from "../../lib/memStickers";
import { cn } from "../../lib/utils";
import {
  BUILTIN_STICKER_IDS,
  clearSticker,
  parseBuiltinStickerSetting,
  saveSticker,
  selectBuiltinSticker,
  stickerFileError,
  stickerSettingKey,
  STICKER_SLOTS,
  type BuiltinStickerId,
  type StickerSlotId,
} from "../../lib/stickers";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const STICKER_SEARCH_IDS: Record<StickerSlotId, Parameters<typeof searchableSetting>[0]> = {
  working: "sticker-working",
  needsYou: "sticker-needs-you",
  finished: "sticker-finished",
};

const STICKER_DESCRIPTIONS: Record<StickerSlotId, string> = {
  working: "Shown in open threads while the agent works.",
  needsYou: "Shown while the agent waits on you for an approval or a question.",
  finished: "Shown right after a turn completes.",
};

const STICKER_LABELS: Record<StickerSlotId, string> = {
  working: "Working",
  needsYou: "Needs you",
  finished: "Finished",
};

function StickerRow({ slot }: { slot: StickerSlotId }) {
  const label = STICKER_LABELS[slot];
  const nameKey = stickerSettingKey(slot);
  const name = useClientSettings((settings) => settings[nameKey]);
  const builtinId = parseBuiltinStickerSetting(name);
  const image = useStickerImage(slot);
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const validation = stickerFileError(file);
    if (validation) {
      setError(validation);
      return;
    }
    setError(null);
    setBusy(true);
    // An atom command settles into a result; no try block keeps this compiled.
    const failure = await saveSticker(slot, file).then(
      () => null,
      (cause: unknown) =>
        cause instanceof Error ? cause.message : "Couldn't save that sticker on this device.",
    );
    if (failure !== null) setError(failure);
    setBusy(false);
  };

  const choosePreset = async (preset: BuiltinStickerId) => {
    setError(null);
    setBusy(true);
    const failure = await selectBuiltinSticker(slot, preset).then(
      () => null,
      () => "Couldn't save that sticker on this device.",
    );
    if (failure !== null) setError(failure);
    setBusy(false);
  };

  const clearImage = async () => {
    setError(null);
    setBusy(true);
    const failure = await clearSticker(slot).then(
      () => null,
      () => "Couldn't remove that sticker on this device.",
    );
    if (failure !== null) setError(failure);
    setBusy(false);
  };

  return (
    <SettingsRow
      {...searchableSetting(STICKER_SEARCH_IDS[slot])}
      description={`${STICKER_DESCRIPTIONS[slot]} Pick a Mem sprite, or upload a PNG, JPEG, or WebP image up to 1 MB. Uploads stay on this device.`}
      status={
        error ? (
          <span className="text-destructive">{error}</span>
        ) : builtinId !== null ? (
          `Using the ${BUILTIN_STICKER_LABELS[builtinId]} sprite.`
        ) : name ? (
          `Using ${name}.`
        ) : (
          "No image."
        )
      }
      control={
        <div className="flex items-center gap-2">
          <div
            aria-hidden="true"
            className={cn(
              "flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-card",
              image === null ? "border-dashed border-border/70" : "border-border/60",
            )}
          >
            {image === null ? (
              <ImagePlusIcon className="size-4 text-muted-foreground" />
            ) : (
              <img
                alt=""
                className="max-h-10 max-w-10 object-contain"
                draggable={false}
                src={image}
              />
            )}
          </div>
          <input
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={(event) => void handleFile(event)}
            ref={inputRef}
            type="file"
          />
          <Button
            aria-label={`Choose ${label} sticker`}
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            size="xs"
            variant="outline"
          >
            <UploadIcon />
            Choose image
          </Button>
          {name ? (
            <Button
              aria-label={`Remove ${label} sticker`}
              disabled={busy}
              onClick={() => void clearImage()}
              size="xs"
              variant="ghost"
            >
              <XIcon />
              Remove
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-1.5 pb-2">
        {BUILTIN_STICKER_IDS.map((preset) => (
          <Button
            aria-label={`Use the ${BUILTIN_STICKER_LABELS[preset]} sprite for ${label}`}
            aria-pressed={builtinId === preset}
            disabled={busy}
            key={preset}
            onClick={() => void choosePreset(preset)}
            size="icon-lg"
            variant={builtinId === preset ? "secondary" : "ghost"}
          >
            <img
              alt=""
              className="max-h-6 max-w-6 object-contain"
              draggable={false}
              src={BUILTIN_STICKER_SRC[preset]}
            />
          </Button>
        ))}
      </div>
    </SettingsRow>
  );
}

export function StickerSettingsSection() {
  return (
    <SettingsSection id="appearance-stickers" title="Stickers">
      {STICKER_SLOTS.map((slot) => (
        <StickerRow key={slot.id} slot={slot.id} />
      ))}
    </SettingsSection>
  );
}
