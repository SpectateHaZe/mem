import { describe, expect, it } from "vite-plus/test";

import {
  BUILTIN_STICKER_IDS,
  builtinStickerSettingValue,
  parseBuiltinStickerSetting,
  STICKERS_MAX_BYTES,
  stickerContentError,
  stickerFileError,
  stickerReactionDurationMs,
  stickerReactionForTurnEnd,
  stickerSlotForTurnState,
} from "./stickers";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

// "RIFF" + size + "WEBP" + chunk payload.
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
]);

const SVG_AS_TEXT = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
);

function stickerFile(input: {
  name: string;
  type?: string;
  bytes?: Uint8Array<ArrayBuffer>;
}): File {
  return new File([input.bytes ?? PNG_BYTES], input.name, { type: input.type ?? "" });
}

describe("sticker file validation", () => {
  it("accepts PNG, JPEG, and WebP files by extension", () => {
    expect(stickerFileError(stickerFile({ name: "sticker.png" }))).toBeNull();
    expect(stickerFileError(stickerFile({ name: "sticker.jpg" }))).toBeNull();
    expect(stickerFileError(stickerFile({ name: "sticker.jpeg" }))).toBeNull();
    expect(stickerFileError(stickerFile({ name: "sticker.webp" }))).toBeNull();
  });

  it("rejects SVG and unknown extensions", () => {
    expect(stickerFileError(stickerFile({ name: "sticker.svg" }))).toBe(
      "Choose a PNG, JPEG, or WebP image.",
    );
    expect(stickerFileError(stickerFile({ name: "sticker.gif" }))).toBe(
      "Choose a PNG, JPEG, or WebP image.",
    );
    expect(stickerFileError(stickerFile({ name: "sticker" }))).toBe(
      "Choose a PNG, JPEG, or WebP image.",
    );
  });

  it("rejects SVG and unknown content types even with an accepted extension", () => {
    expect(stickerFileError(stickerFile({ name: "sticker.png", type: "image/svg+xml" }))).toBe(
      "Choose a PNG, JPEG, or WebP image.",
    );
    expect(stickerFileError(stickerFile({ name: "sticker.png", type: "image/webx" }))).toBe(
      "Choose a PNG, JPEG, or WebP image.",
    );
  });

  it("rejects files larger than 1 MB", () => {
    expect(
      stickerFileError(
        stickerFile({ name: "big.png", bytes: new Uint8Array(STICKERS_MAX_BYTES + 1) }),
      ),
    ).toBe("Choose an image smaller than 1 MB.");
    expect(
      stickerFileError(
        stickerFile({ name: "exact.png", bytes: new Uint8Array(STICKERS_MAX_BYTES) }),
      ),
    ).toBeNull();
  });

  it("accepts real PNG, JPEG, and WebP bytes regardless of the claimed type", async () => {
    await expect(stickerContentError(stickerFile({ name: "a.png" }))).resolves.toBeNull();
    await expect(
      stickerContentError(stickerFile({ name: "a.jpg", bytes: JPEG_BYTES })),
    ).resolves.toBeNull();
    await expect(
      stickerContentError(stickerFile({ name: "a.webp", bytes: WEBP_BYTES })),
    ).resolves.toBeNull();
  });

  it("rejects bytes that are not PNG, JPEG, or WebP even when the extension lies", async () => {
    await expect(
      stickerContentError(stickerFile({ name: "a.png", bytes: SVG_AS_TEXT })),
    ).resolves.toBe("That file is not a PNG, JPEG, or WebP image.");
  });

  it("rejects WebP-like RIFF containers that are not WebP", async () => {
    const riffOnly = new Uint8Array(WEBP_BYTES);
    riffOnly[8] = 0x52;
    riffOnly[9] = 0x46;
    riffOnly[10] = 0x4d;
    riffOnly[11] = 0x50;
    await expect(
      stickerContentError(stickerFile({ name: "a.webp", bytes: riffOnly })),
    ).resolves.toBe("That file is not a PNG, JPEG, or WebP image.");
  });
});

describe("sticker slot for turn state", () => {
  it("shows the working sticker while the agent runs", () => {
    expect(
      stickerSlotForTurnState({
        isWorking: true,
        awaitingUser: null,
        turnRecentlyCompleted: false,
      }),
    ).toBe("working");
  });

  it("shows the needs-you sticker for approvals and for questions", () => {
    expect(
      stickerSlotForTurnState({
        isWorking: true,
        awaitingUser: "approval",
        turnRecentlyCompleted: false,
      }),
    ).toBe("needsYou");
    expect(
      stickerSlotForTurnState({
        isWorking: false,
        awaitingUser: "input",
        turnRecentlyCompleted: false,
      }),
    ).toBe("needsYou");
  });

  it("prefers needs-you over working when the agent asks while running", () => {
    expect(
      stickerSlotForTurnState({
        isWorking: true,
        awaitingUser: "input",
        turnRecentlyCompleted: false,
      }),
    ).toBe("needsYou");
  });

  it("shows the finished sticker for a turn that just completed", () => {
    expect(
      stickerSlotForTurnState({
        isWorking: false,
        awaitingUser: null,
        turnRecentlyCompleted: true,
      }),
    ).toBe("finished");
  });

  it("shows nothing when the thread is idle", () => {
    expect(
      stickerSlotForTurnState({
        isWorking: false,
        awaitingUser: null,
        turnRecentlyCompleted: false,
      }),
    ).toBeNull();
  });
});

describe("built-in sticker settings", () => {
  it("round-trips every shipped sprite id", () => {
    for (const id of BUILTIN_STICKER_IDS) {
      expect(parseBuiltinStickerSetting(builtinStickerSettingValue(id))).toBe(id);
    }
  });

  it("reads anything else as an uploaded file's name", () => {
    expect(parseBuiltinStickerSetting("")).toBeNull();
    expect(parseBuiltinStickerSetting("my-cat.png")).toBeNull();
    expect(parseBuiltinStickerSetting("mem-happy.webp")).toBeNull();
    expect(parseBuiltinStickerSetting("mem:mem-happy.png")).toBeNull();
  });
});

describe("sticker reaction for a turn that ended", () => {
  it("celebrates a completed turn briefly", () => {
    expect(stickerReactionForTurnEnd({ failed: false })).toBe("celebrate");
    expect(stickerReactionDurationMs("celebrate")).toBe(1200);
  });

  it("holds the distressed sprite a little longer after a failure", () => {
    expect(stickerReactionForTurnEnd({ failed: true })).toBe("distressed");
    expect(stickerReactionDurationMs("distressed")).toBe(2000);
  });
});
