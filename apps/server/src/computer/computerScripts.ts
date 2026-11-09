import type { ComputerActInput, ComputerUseMode } from "@t3tools/contracts";

export const MAX_SCREENSHOT_WIDTH = 1280;

// DPI awareness comes first so screen sizes and cursor positions are real pixels.
const PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Mem -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, int d, UIntPtr e);'
[Mem.U]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$s = [Math]::Min(1.0, ${MAX_SCREENSHOT_WIDTH} / $b.Width)
`;

export const SCREENSHOT_SCRIPT = `${PRELUDE}
$f = New-Object Drawing.Bitmap $b.Width, $b.Height
$g = [Drawing.Graphics]::FromImage($f)
$g.CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size)
$w = [int]($b.Width * $s); $h = [int]($b.Height * $s)
$t = New-Object Drawing.Bitmap $f, $w, $h
$m = New-Object IO.MemoryStream
$t.Save($m, [Drawing.Imaging.ImageFormat]::Png)
"$w $h " + [Convert]::ToBase64String($m.ToArray())
`;

const NAMED_KEYS: Readonly<Record<string, string>> = {
  enter: "{ENTER}",
  return: "{ENTER}",
  tab: "{TAB}",
  escape: "{ESC}",
  esc: "{ESC}",
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  pagedown: "{PGDN}",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  space: " ",
};
const MODIFIERS: Readonly<Record<string, string>> = { ctrl: "^", shift: "+", alt: "%" };

export const escapeSendKeys = (text: string) =>
  text.replace(/[+^%~(){}[\]]/g, "{$&}").replace(/\r?\n/g, "{ENTER}");

export const comboToSendKeys = (combo: string) => {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((part) => part.trim());
  const key = parts.at(-1) ?? "";
  const modifiers = parts.slice(0, -1).map((part) => MODIFIERS[part]);
  if (key === "" || modifiers.some((modifier) => modifier === undefined)) return undefined;
  const named =
    NAMED_KEYS[key] ?? (/^f([1-9]|1[0-6])$/.test(key) ? `{${key.toUpperCase()}}` : undefined);
  if (named === undefined && key.length !== 1) return undefined;
  return modifiers.join("") + (named ?? escapeSendKeys(key));
};

const MOUSE_FLAGS = {
  click: [[2, 4]],
  double_click: [
    [2, 4],
    [2, 4],
  ],
  right_click: [[8, 16]],
} as const;

/** A script and its one untrusted value, which travels in the environment rather than the source. */
export const actScript = (
  input: ComputerActInput,
): { readonly script: string; readonly keys?: string } | string => {
  if (input.action === "type" || input.action === "key") {
    if (input.text === undefined || input.text === "") return `\`${input.action}\` needs text.`;
    const keys = input.action === "type" ? escapeSendKeys(input.text) : comboToSendKeys(input.text);
    if (keys === undefined) return `Unknown key combination: ${input.text}`;
    return { script: `${PRELUDE}[System.Windows.Forms.SendKeys]::SendWait($env:MEM_KEYS)`, keys };
  }
  if (input.x === undefined || input.y === undefined) return `\`${input.action}\` needs x and y.`;
  const move = `[Mem.U]::SetCursorPos([int](${input.x} / $s), [int](${input.y} / $s)) | Out-Null`;
  if (input.action === "move") return { script: `${PRELUDE}${move}` };
  if (input.action === "scroll") {
    if (input.amount === undefined) return "`scroll` needs amount.";
    return {
      script: `${PRELUDE}${move}\n[Mem.U]::mouse_event(0x800, 0, 0, ${input.amount * 120}, [UIntPtr]::Zero)`,
    };
  }
  const presses = MOUSE_FLAGS[input.action]
    .flat()
    .map((flag) => `[Mem.U]::mouse_event(${flag}, 0, 0, 0, [UIntPtr]::Zero)`);
  return { script: `${PRELUDE}${move}\n${presses.join("\n")}` };
};

export const computerUseRefusal = (mode: ComputerUseMode, platform: string, acting: boolean) => {
  if (platform !== "win32" && platform !== "darwin") {
    return "Computer control only works on Windows and macOS hosts for now.";
  }
  if (mode === "off") return "Computer control is turned off in Mem's settings.";
  if (mode === "view" && acting)
    return "Mem's settings allow viewing the screen but not controlling it.";
  return undefined;
};

export const parseScreenshot = (output: string) => {
  const match = /^(\d+) (\d+) (\S+)\s*$/.exec(output);
  return match === null
    ? undefined
    : { width: Number(match[1]), height: Number(match[2]), data: match[3]! };
};
