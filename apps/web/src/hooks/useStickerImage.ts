import { useEffect, useState } from "react";

import { useClientSettings } from "./useSettings";
import { BUILTIN_STICKER_SRC } from "../lib/memStickers";
import {
  parseBuiltinStickerSetting,
  readStickerBlob,
  stickerSettingKey,
  type StickerSlotId,
} from "../lib/stickers";

/**
 * A built-in sprite is a static asset; an upload lives in this device's
 * IndexedDB, so it only reaches the DOM through an object URL. The loaded entry
 * carries its own slot and file name, so render stays derived rather than reset.
 */
export function useStickerImage(slot: StickerSlotId): string | null {
  const nameKey = stickerSettingKey(slot);
  const name = useClientSettings((settings) => settings[nameKey]);
  const builtinId = parseBuiltinStickerSetting(name);
  const [loaded, setLoaded] = useState<{
    slot: StickerSlotId;
    name: string;
    url: string;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the blob read is outside React, so the URL has to land in state
  useEffect(() => {
    if (name === "" || builtinId !== null) return;
    let cancelled = false;
    let url: string | null = null;
    void readStickerBlob(slot)
      .then((blob) => {
        if (cancelled || blob === null) return;
        url = URL.createObjectURL(blob);
        setLoaded({ slot, name, url });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [slot, name, builtinId]);
  if (builtinId !== null) return BUILTIN_STICKER_SRC[builtinId];
  return loaded !== null && loaded.slot === slot && loaded.name === name ? loaded.url : null;
}
