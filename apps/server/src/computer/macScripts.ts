import type { ComputerActInput } from "@t3tools/contracts";

import { MAX_SCREENSHOT_WIDTH } from "./computerScripts.ts";

/** Absolute paths so spawning never depends on PATH. */
const MAC_OSASCRIPT = "/usr/bin/osascript";
export const MAC_SCREENCAPTURE = "/usr/sbin/screencapture";
export const MAC_SIPS = "/usr/bin/sips";

// Measures logical points and backing pixels with scalar-returning functions only, so the JXA bridge needs nothing fancy.
const MEASURE_HELPERS = `function screenSize() {
  var display = $.CGMainDisplayID()
  var mode = $.CGDisplayCopyDisplayMode(display)
  if (typeof $.CGDisplayModeGetWidth !== 'function' || !mode) return 'UNSUPPORTED:CGDisplayMode'
  return [$.CGDisplayModeGetWidth(mode), $.CGDisplayModeGetHeight(mode), $.CGDisplayPixelsWide(display), $.CGDisplayPixelsHigh(display)].join(' ')
}`;

// Mouse actions need the scale but not Screen Recording, so they measure without preflighting it.
export const MAC_MEASURE_ARGUMENTS = [
  MAC_OSASCRIPT,
  "-l",
  "JavaScript",
  "-e",
  `ObjC.import('CoreGraphics')\n${MEASURE_HELPERS}\nscreenSize()`,
] as const;

// Screenshots preflight Screen Recording first, so a missing grant fails loudly instead of returning wallpaper.
export const MAC_INFO_ARGUMENTS = [
  MAC_OSASCRIPT,
  "-l",
  "JavaScript",
  "-e",
  `ObjC.import('CoreGraphics')\n${MEASURE_HELPERS}\nmain()\nfunction main() {\n  if (typeof $.CGPreflightScreenCaptureAccess !== 'function') return 'UNSUPPORTED:CGPreflightScreenCaptureAccess'\n  if (!$.CGPreflightScreenCaptureAccess()) return 'PERMISSION:Screen Recording'\n  return screenSize()\n}`,
] as const;

// kCGEvent*, kCGScroll* and kCGMouseButton* are macros the ObjC bridge cannot import, so real constants are inlined.
const MAC_ACT_SCRIPT = `
ObjC.import('CoreGraphics')
ObjC.import('ApplicationServices')
var SystemEvents = null
function app() { return SystemEvents || (SystemEvents = Application('System Events')) }
var MODIFIERS = { command: 'command down', control: 'control down', option: 'option down', shift: 'shift down' }
var env = ObjC.deepUnwrap($.NSProcessInfo.processInfo.environment) || {}
if (typeof $.CGEventCreateMouseEvent !== 'function' || typeof $.CGEventPost !== 'function' || typeof $.AXIsProcessTrusted !== 'function') 'UNSUPPORTED:CGEvent'
else if (!$.AXIsProcessTrusted()) 'PERMISSION:Accessibility'
else if (env.MEM_ACTION === 'mouse') (function () {
  var point = { x: parseFloat(env.MEM_X), y: parseFloat(env.MEM_Y) }
  var button = parseInt(env.MEM_MOUSE_BUTTON, 10) || 0
  var types = env.MEM_MOUSE_TYPES.split(',').map(Number)
  var clicks = env.MEM_MOUSE_CLICKS.split(',').map(Number)
  for (var i = 0; i < types.length; i++) {
    var event = $.CGEventCreateMouseEvent($(), types[i], point, button)
    if (!event) return 'UNSUPPORTED:CGEventCreateMouseEvent'
    if (clicks[i] > 1) $.CGEventSetIntegerValueField(event, 1, clicks[i])
    $.CGEventPost(0, event)
  }
  return 'OK'
})()
else if (env.MEM_ACTION === 'scroll') (function () {
  var point = { x: parseFloat(env.MEM_X), y: parseFloat(env.MEM_Y) }
  var move = $.CGEventCreateMouseEvent($(), 5, point, 0)
  if (move) $.CGEventPost(0, move)
  var event = $.CGEventCreateScrollWheelEvent($(), 1, 1, parseInt(env.MEM_WHEEL, 10) || 0)
  if (!event) return 'UNSUPPORTED:CGEventCreateScrollWheelEvent'
  $.CGEventPost(0, event)
  return 'OK'
})()
else if (env.MEM_ACTION === 'type') (app().keystroke(env.MEM_TYPE_TEXT || ''), 'OK')
else if (env.MEM_ACTION === 'key') (function () {
  var modifiers = (env.MEM_KEY_MODIFIERS || '').split('+').filter(function (each) { return each !== '' }).map(function (each) { return MODIFIERS[each] })
  if (modifiers.some(function (each) { return each === undefined })) return 'BAD:MODIFIERS'
  var options = modifiers.length === 0 ? {} : { using: modifiers }
  if (env.MEM_KEY_CODE !== '') app().keyCode(parseInt(env.MEM_KEY_CODE, 10), options)
  else app().keystroke(env.MEM_KEY_CHAR || '', options)
  return 'OK'
})()
else 'BAD:ACTION'`;

/** A fixed program plus untrusted values that travel in the environment, never in the source. */
export type MacPlan = {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

const macPlan = (env: Readonly<Record<string, string>>): MacPlan => ({
  argv: [MAC_OSASCRIPT, "-l", "JavaScript", "-e", MAC_ACT_SCRIPT],
  env,
});

export type MacScreenInfo = {
  readonly pointWidth: number;
  readonly pointHeight: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
};

export type MacInfoOutcome =
  | { readonly kind: "info"; readonly info: MacScreenInfo }
  | { readonly kind: "permission"; readonly permission: "screen-recording" | "accessibility" }
  | { readonly kind: "unsupported"; readonly what: string };

/**
 * The INFO script prints `pointWidth pointHeight pixelWidth pixelHeight`, or a
 * `PERMISSION:<name>` / `UNSUPPORTED:<name>` sentinel instead.
 */
export const parseMacInfo = (output: string): MacInfoOutcome | undefined => {
  const line = output.trim();
  if (line.startsWith("PERMISSION:")) {
    return line.includes("Accessibility")
      ? { kind: "permission", permission: "accessibility" }
      : { kind: "permission", permission: "screen-recording" };
  }
  const unsupported = /^UNSUPPORTED:(\S+)$/.exec(line);
  if (unsupported !== null) return { kind: "unsupported", what: unsupported[1]! };
  const values = line.split(/\s+/).map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value) || value <= 0))
    return undefined;
  return {
    kind: "info",
    info: {
      pointWidth: values[0]!,
      pointHeight: values[1]!,
      pixelWidth: values[2]!,
      pixelHeight: values[3]!,
    },
  };
};

export const pngDimensions = (
  png: Buffer,
): { readonly width: number; readonly height: number } | undefined => {
  // [signature 0..8][IHDR length + type 0..16][big-endian width][big-endian height].
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return png.length < 24 || !png.subarray(0, 8).equals(signature)
    ? undefined
    : { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};

/** Same downscale semantics as the Windows screenshot: shrink by width only. */
export const macResizePlan = (width: number, height: number) => {
  const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / width);
  return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
};

export const macSipsArguments = (
  height: number,
  width: number,
  input: string,
  output: string,
): readonly string[] => ["-z", String(height), String(width), input, "--out", output];

/** A screenshot pixel of the image the agent saw covers this many screen points. */
export const macPointFactor = (info: MacScreenInfo): number =>
  info.pointWidth /
  Math.round(info.pixelWidth * Math.min(1, MAX_SCREENSHOT_WIDTH / info.pixelWidth));

const formatPoint = (points: number) => String(Math.round(points * 100) / 100);

// 1 = left down, 2 = left up, 3 = right down, 4 = right up. The second pair of a double click carries click state 2.
const MAC_CLICK_SEQUENCES = {
  click: { types: [1, 2], states: [1, 1], button: 0 },
  double_click: { types: [1, 2, 1, 2], states: [1, 1, 2, 2], button: 0 },
  right_click: { types: [3, 4], states: [1, 1], button: 1 },
} as const;

/** Builds the fixed program's environment. Agent-provided text and coordinates only ever travel in `env`. */
export const macActPlan = (input: ComputerActInput, factor: number): MacPlan | string => {
  const point = (x: number, y: number): Record<string, string> => ({
    MEM_X: formatPoint(x * factor),
    MEM_Y: formatPoint(y * factor),
  });
  if (input.action === "type" || input.action === "key") {
    if (input.text === undefined || input.text === "") return `\`${input.action}\` needs text.`;
    if (input.action === "type") {
      // A carriage return makes System Events press Return, mirroring SendKeys' {ENTER}.
      return macPlan({ MEM_ACTION: "type", MEM_TYPE_TEXT: input.text.replace(/\r?\n/g, "\r") });
    }
    const event = macKeyEvent(input.text);
    if (event === undefined) return `Unknown key combination: ${input.text}`;
    return macPlan({
      MEM_ACTION: "key",
      MEM_KEY_CODE: event.keyCode === undefined ? "" : String(event.keyCode),
      MEM_KEY_CHAR: event.char ?? "",
      MEM_KEY_MODIFIERS: event.modifiers.join("+"),
    });
  }
  if (input.x === undefined || input.y === undefined) {
    return `\`${input.action}\` needs x and y.`;
  }
  if (input.action === "move") {
    return macPlan({
      MEM_ACTION: "mouse",
      MEM_MOUSE_TYPES: "5",
      MEM_MOUSE_CLICKS: "1",
      MEM_MOUSE_BUTTON: "0",
      ...point(input.x, input.y),
    });
  }
  if (input.action === "scroll") {
    if (input.amount === undefined) return "`scroll` needs amount.";
    // Positive scrolls up on both platforms; three line units per notch approximates Windows' 120.
    return macPlan({
      MEM_ACTION: "scroll",
      MEM_WHEEL: String(input.amount * 3),
      ...point(input.x, input.y),
    });
  }
  const sequence = MAC_CLICK_SEQUENCES[input.action];
  return macPlan({
    MEM_ACTION: "mouse",
    MEM_MOUSE_TYPES: sequence.types.join(","),
    MEM_MOUSE_CLICKS: sequence.states.join(","),
    MEM_MOUSE_BUTTON: String(sequence.button),
    ...point(input.x, input.y),
  });
};

export type MacKeyEvent = {
  readonly keyCode?: number;
  readonly char?: string;
  readonly modifiers: readonly string[];
};

// Hardware key codes from Apple's HIToolbox Events.h, since System Events has no named lookup.
const MAC_KEY_CODES: Readonly<Record<string, number>> = {
  enter: 36,
  return: 36,
  tab: 48,
  escape: 53,
  esc: 53,
  backspace: 51,
  delete: 117,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  space: 49,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
  f13: 105,
  f14: 107,
  f15: 113,
  f16: 106,
};

const MAC_MODIFIERS: Readonly<Record<string, string>> = {
  ctrl: "control",
  shift: "shift",
  alt: "option",
  option: "option",
  cmd: "command",
  command: "command",
};

/** Same combo syntax as Windows' `comboToSendKeys`; only the tables differ. */
export const macKeyEvent = (combo: string): MacKeyEvent | undefined => {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((part) => part.trim());
  const key = parts.at(-1) ?? "";
  const modifiers: ReadonlyArray<string | undefined> = parts
    .slice(0, -1)
    .map((part) => MAC_MODIFIERS[part]);
  if (key === "" || modifiers.some((modifier) => modifier === undefined)) return undefined;
  if (MAC_KEY_CODES[key] === undefined && key.length !== 1) return undefined;
  return {
    ...(MAC_KEY_CODES[key] === undefined ? { char: key } : { keyCode: MAC_KEY_CODES[key] }),
    modifiers: modifiers as readonly string[],
  };
};

/** What the fixed act program means by the one line it prints. */
export type MacActionOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "permission"; readonly permission: "screen-recording" | "accessibility" }
  | { readonly kind: "unsupported"; readonly what: string }
  | { readonly kind: "bad" };

export const interpretMacAction = (output: string): MacActionOutcome => {
  const line = output.trim();
  if (line === "OK") return { kind: "ok" };
  if (line.startsWith("PERMISSION:")) {
    return {
      kind: "permission",
      permission: line.includes("Accessibility") ? "accessibility" : "screen-recording",
    };
  }
  const unsupported = /^UNSUPPORTED:(\S+)$/.exec(line);
  if (unsupported !== null) return { kind: "unsupported", what: unsupported[1]! };
  return { kind: "bad" };
};
