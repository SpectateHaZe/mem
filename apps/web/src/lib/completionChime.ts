import { getClientSettings, updateClientSettings } from "../hooks/useSettings";

const DATABASE_NAME = "t3code-completion-chime";
const DATABASE_VERSION = 1;
const STORE_NAME = "custom-sound";
const RECORD_KEY = "file";

export const COMPLETION_CHIME_MAX_BYTES = 2 * 1024 * 1024;

const AUDIO_FILE_EXTENSIONS = /\.(aac|flac|m4a|mp3|oga|ogg|opus|wav|weba|webm)$/i;

let audioContext: AudioContext | undefined;
let customBufferPromise: Promise<AudioBuffer | null> | null = null;

export function completionChimeFileError(file: File): string | null {
  const type = file.type.toLowerCase();
  if (!type.startsWith("audio/") && !AUDIO_FILE_EXTENSIONS.test(file.name)) {
    return "Choose an audio file.";
  }
  if (file.size > COMPLETION_CHIME_MAX_BYTES) {
    return "Choose an audio file smaller than 2 MB.";
  }
  return null;
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

async function readCustomSound(): Promise<Blob | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const value = await runStoreRequest<unknown>("readonly", (store) => store.get(RECORD_KEY));
    return value instanceof Blob ? value : null;
  } catch {
    return null;
  }
}

export async function saveCustomCompletionSound(file: File): Promise<void> {
  const error = completionChimeFileError(file);
  if (error) throw new Error(error);
  if (typeof indexedDB === "undefined") throw new Error("Custom sounds are unavailable here.");
  await runStoreRequest("readwrite", (store) => store.put(file, RECORD_KEY));
  customBufferPromise = null;
  await updateClientSettings({ completionChimeCustomSoundName: file.name });
}

export async function clearCustomCompletionSound(): Promise<void> {
  customBufferPromise = null;
  if (typeof indexedDB !== "undefined") {
    try {
      await runStoreRequest("readwrite", (store) => store.delete(RECORD_KEY));
    } catch {
      // A missing database or record already means there is no custom sound.
    }
  }
  await updateClientSettings({ completionChimeCustomSoundName: "" });
}

function ensureAudioContext(): AudioContext | undefined {
  if (typeof AudioContext === "undefined") return undefined;
  if (!audioContext) {
    try {
      audioContext = new AudioContext();
    } catch {
      return undefined;
    }
  }
  return audioContext;
}

export function unlockCompletionChime(): void {
  const context = ensureAudioContext();
  if (context?.state === "suspended") void context.resume().catch(() => undefined);
}

if (typeof document !== "undefined") {
  const unlock = () => {
    document.removeEventListener("pointerdown", unlock);
    document.removeEventListener("keydown", unlock);
    unlockCompletionChime();
  };
  document.addEventListener("pointerdown", unlock, { passive: true });
  document.addEventListener("keydown", unlock);
}

function loadCustomBuffer(context: AudioContext): Promise<AudioBuffer | null> {
  customBufferPromise ??= readCustomSound()
    .then(async (blob) => {
      if (!blob) return null;
      return await context.decodeAudioData(await blob.arrayBuffer());
    })
    .catch(() => null);
  return customBufferPromise;
}

function playDefaultChime(context: AudioContext, volume: number): void {
  if (volume <= 0) return;
  const start = context.currentTime;
  const notes = [
    { frequency: 880, offset: 0, duration: 0.16 },
    { frequency: 1318.51, offset: 0.09, duration: 0.2 },
  ];
  for (const note of notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = note.frequency;
    gain.gain.setValueAtTime(0, start + note.offset);
    gain.gain.linearRampToValueAtTime(volume * 0.35, start + note.offset + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + note.offset + note.duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start + note.offset);
    oscillator.stop(start + note.offset + note.duration + 0.02);
  }
}

function playBuffer(context: AudioContext, buffer: AudioBuffer, volume: number): void {
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = buffer;
  gain.gain.value = volume;
  source.connect(gain);
  gain.connect(context.destination);
  source.start();
}

export async function playCompletionChime(options?: { readonly force?: boolean }): Promise<void> {
  const settings = getClientSettings();
  if (!options?.force && !settings.completionChimeEnabled) return;
  const context = ensureAudioContext();
  if (!context) return;
  try {
    if (context.state !== "running") await context.resume();
    if (context.state !== "running") return;
    const volume = settings.completionChimeVolume / 100;
    if (settings.completionChimeCustomSoundName !== "") {
      const buffer = await loadCustomBuffer(context);
      if (buffer) {
        playBuffer(context, buffer, volume);
        return;
      }
    }
    playDefaultChime(context, volume);
  } catch {
    // Playback is best effort, so a blocked context or a bad file stays silent.
  }
}
