import memCelebrate from "../assets/mem-celebrate.webp";
import memDistressed from "../assets/mem-distressed.webp";
import memHappy from "../assets/mem-happy.webp";
import memInControl from "../assets/mem-in-control.webp";
import memSleeping from "../assets/mem-sleeping.webp";
import memWave from "../assets/mem-wave.webp";
import type { BuiltinStickerId } from "./stickers";

/** Static URLs for the built-in sprites; Vite hashes them, so imports are the only names. */
export const BUILTIN_STICKER_SRC: Readonly<Record<BuiltinStickerId, string>> = {
  "mem-happy": memHappy,
  "mem-wave": memWave,
  "mem-sleeping": memSleeping,
  "mem-celebrate": memCelebrate,
  "mem-distressed": memDistressed,
  "mem-in-control": memInControl,
};

export const BUILTIN_STICKER_LABELS: Readonly<Record<BuiltinStickerId, string>> = {
  "mem-happy": "Happy",
  "mem-wave": "Wave",
  "mem-sleeping": "Sleeping",
  "mem-celebrate": "Celebrate",
  "mem-distressed": "Distressed",
  "mem-in-control": "In control",
};

/** What the floating mascot is reacting to; it is not persisted. */
export type MemMood = "idle" | "working" | "needsYou" | "finished" | "failed";

export const MEM_MOOD_SPRITE: Readonly<Record<MemMood, BuiltinStickerId>> = {
  idle: "mem-happy",
  working: "mem-in-control",
  needsYou: "mem-distressed",
  finished: "mem-celebrate",
  failed: "mem-distressed",
};
