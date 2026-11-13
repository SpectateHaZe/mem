import { ImagePlusIcon, UploadIcon, XIcon } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useStickerImage } from "../../hooks/useStickerImage";
import { cn } from "../../lib/utils";
import {
  clearSticker,
  saveSticker,
  stickerFileError,
  stickerSettingKey,
  STICKER_SLOTS,
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
      description={`${STICKER_DESCRIPTIONS[slot]} Accepts a PNG, JPEG, or WebP image up to 1 MB. It stays on this device.`}
      status={
        error ? (
          <span className="text-destructive">{error}</span>
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
    />
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
