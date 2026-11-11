import { updateClientSettings } from "../hooks/useSettings";

const DATABASE_NAME = "t3code-stickers";
const DATABASE_VERSION = 1;
const STORE_NAME = "sticker";

export const STICKERS_MAX_BYTES = 1024 * 1024;

/** The three chat states a sticker can decorate. */
export type StickerSlotId = "working" | "needsYou" | "finished";

export type StickerSettingNameKey =
  | "stickerWorkingName"
  | "stickerNeedsYouName"
  | "stickerFinishedName";

const STICKER_SETTINGS_KEY: Readonly<Record<StickerSlotId, StickerSettingNameKey>> = {
  working: "stickerWorkingName",
  needsYou: "stickerNeedsYouName",
  finished: "stickerFinishedName",
};

export const STICKER_SLOTS: ReadonlyArray<{
  readonly id: StickerSlotId;
  readonly label: string;
}> = [
  { id: "working", label: "Working" },
  { id: "needsYou", label: "Needs you" },
  { id: "finished", label: "Finished" },
];

export function stickerSettingKey(slot: StickerSlotId): StickerSettingNameKey {
  return STICKER_SETTINGS_KEY[slot];
}

/**
 * Built-in sprites ship inside the bundle, so a slot's setting stores the id
 * behind a prefix instead of an uploaded file's name. Anything without the
 * prefix is an upload, which keeps existing settings readable.
 */
export type BuiltinStickerId =
  | "mem-happy"
  | "mem-wave"
  | "mem-sleeping"
  | "mem-celebrate"
  | "mem-distressed"
  | "mem-in-control";

export const BUILTIN_STICKER_IDS: ReadonlyArray<BuiltinStickerId> = [
  "mem-happy",
  "mem-wave",
  "mem-sleeping",
  "mem-celebrate",
  "mem-distressed",
  "mem-in-control",
];

const BUILTIN_SETTING_PREFIX = "mem:";

export function builtinStickerSettingValue(id: BuiltinStickerId): string {
  return `${BUILTIN_SETTING_PREFIX}${id}`;
}

export function parseBuiltinStickerSetting(value: string): BuiltinStickerId | null {
  if (!value.startsWith(BUILTIN_SETTING_PREFIX)) return null;
  const id = value.slice(BUILTIN_SETTING_PREFIX.length);
  return BUILTIN_STICKER_IDS.find((candidate) => candidate === id) ?? null;
}

/** A turn's end is celebrated briefly, or mourned a little longer when it failed. */
const STICKER_TRANSIENT_CELEBRATE_MS = 1200;
const STICKER_TRANSIENT_DISTRESS_MS = 2000;

export type StickerReaction = "celebrate" | "distressed";

export function stickerReactionForTurnEnd(input: { readonly failed: boolean }): StickerReaction {
  return input.failed ? "distressed" : "celebrate";
}

export function stickerReactionDurationMs(reaction: StickerReaction): number {
  return reaction === "distressed" ? STICKER_TRANSIENT_DISTRESS_MS : STICKER_TRANSIENT_CELEBRATE_MS;
}

export async function selectBuiltinSticker(
  slot: StickerSlotId,
  id: BuiltinStickerId,
): Promise<void> {
  await updateClientSettings({ [stickerSettingKey(slot)]: builtinStickerSettingValue(id) });
}

/** The state shown in the chat view for each slot; see the ThreadSticker component. */
export type ThreadStickerAttention = "approval" | "input" | null;

/**
 * Needs-you outranks working: the agent stopped to ask, so it is not making
 * progress. Finished is a "turn just ended" transition supplied by the caller.
 */
export function stickerSlotForTurnState(input: {
  readonly isWorking: boolean;
  readonly awaitingUser: ThreadStickerAttention;
  readonly turnRecentlyCompleted: boolean;
}): StickerSlotId | null {
  if (input.awaitingUser !== null) return "needsYou";
  if (input.isWorking) return "working";
  if (input.turnRecentlyCompleted) return "finished";
  return null;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp)$/i;
const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);

export function stickerFileError(file: File): string | null {
  const type = file.type.toLowerCase();
  if (!IMAGE_EXTENSIONS.test(file.name) || (type !== "" && !IMAGE_MIME_TYPES.has(type))) {
    return "Choose a PNG, JPEG, or WebP image.";
  }
  if (file.size > STICKERS_MAX_BYTES) {
    return "Choose an image smaller than 1 MB.";
  }
  return null;
}

/** Reads the file's bytes so a renamed SVG or text file cannot pass the extension check. */
export async function stickerContentError(file: File): Promise<string | null> {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (looksPngLike(bytes) || looksJpegLike(bytes) || looksWebpLike(bytes)) return null;
  return "That file is not a PNG, JPEG, or WebP image.";
}

function looksPngLike(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function looksJpegLike(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function looksWebpLike(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runStoreRequest<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => reject(transaction.error);
        const request = action(transaction.objectStore(STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

export async function readStickerBlob(slot: StickerSlotId): Promise<Blob | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const value = await runStoreRequest<unknown>("readonly", (store) => store.get(slot));
    return value instanceof Blob ? value : null;
  } catch {
    return null;
  }
}

function isQuotaError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "QuotaExceededError";
}

export async function saveSticker(slot: StickerSlotId, file: File): Promise<void> {
  const error = stickerFileError(file);
  if (error) throw new Error(error);
  const contentError = await stickerContentError(file);
  if (contentError) throw new Error(contentError);
  if (typeof indexedDB === "undefined") {
    throw new Error("Stickers are unavailable in this browser context.");
  }
  try {
    await runStoreRequest("readwrite", (store) => store.put(file, slot));
  } catch (cause) {
    if (isQuotaError(cause)) {
      throw new Error("That device's storage is full, so the sticker wasn't saved.", { cause });
    }
    throw cause;
  }
  await updateClientSettings({ [stickerSettingKey(slot)]: file.name });
}

export async function clearSticker(slot: StickerSlotId): Promise<void> {
  if (typeof indexedDB !== "undefined") {
    try {
      await runStoreRequest("readwrite", (store) => store.delete(slot));
    } catch {
      // A missing database or record already means there is no sticker.
    }
  }
  await updateClientSettings({ [stickerSettingKey(slot)]: "" });
}
