import { assert, it } from "@effect/vitest";
import type { ComputerActInput } from "@t3tools/contracts";

import {
  MAC_INFO_ARGUMENTS,
  MAC_SIPS,
  interpretMacAction,
  macActPlan,
  macKeyEvent,
  macPointFactor,
  macResizePlan,
  macSipsArguments,
  parseMacInfo,
  pngDimensions,
} from "./macScripts.ts";

const expectInfo = (output: string) => {
  const outcome = parseMacInfo(output);
  if (outcome?.kind !== "info") throw new Error("fixture");
  return outcome.info;
};

const RETINA_INFO = expectInfo("1512 982 3024 1964");
const factor = macPointFactor(RETINA_INFO);

const acts = (input: ComputerActInput) => {
  const plan = macActPlan(input, factor);
  if (typeof plan === "string") throw new Error(plan);
  return plan;
};

it("runs every action through one fixed osascript program", () => {
  const plans = [
    acts({ action: "move", x: 1, y: 1 }),
    acts({ action: "click", x: 1, y: 1 }),
    acts({ action: "double_click", x: 1, y: 1 }),
    acts({ action: "right_click", x: 1, y: 1 }),
    acts({ action: "scroll", x: 1, y: 1, amount: 2 }),
    acts({ action: "type", text: "hi" }),
    acts({ action: "key", text: "ctrl+c" }),
  ];
  for (const plan of plans) {
    assert.equal(plan.argv[0], "/usr/bin/osascript");
    assert.deepEqual(plan.argv.slice(1, 4), ["-l", "JavaScript", "-e"]);
  }
  assert.equal(new Set(plans.map((plan) => plan.argv.at(-1))).size, 1);
});

it("clicks carry flag lists like the Windows mouse_event flags", () => {
  const move = acts({ action: "move", x: 10, y: 10 });
  assert.equal(move.env.MEM_ACTION, "mouse");
  assert.equal(move.env.MEM_MOUSE_TYPES, "5");
  assert.equal(move.env.MEM_MOUSE_BUTTON, "0");
  const click = acts({ action: "click", x: 10, y: 10 });
  assert.equal(click.env.MEM_MOUSE_TYPES, "1,2");
  assert.equal(click.env.MEM_MOUSE_CLICKS, "1,1");
  const double = acts({ action: "double_click", x: 10, y: 10 });
  assert.equal(double.env.MEM_MOUSE_TYPES, "1,2,1,2");
  assert.equal(double.env.MEM_MOUSE_CLICKS, "1,1,2,2");
  const right = acts({ action: "right_click", x: 10, y: 10 });
  assert.equal(right.env.MEM_MOUSE_TYPES, "3,4");
  assert.equal(right.env.MEM_MOUSE_BUTTON, "1");
});

it("scrolls with positive up, three line units per notch", () => {
  const up = acts({ action: "scroll", x: 10, y: 10, amount: 2 });
  assert.equal(up.env.MEM_ACTION, "scroll");
  assert.equal(up.env.MEM_WHEEL, "6");
  const down = acts({ action: "scroll", x: 10, y: 10, amount: -1 });
  assert.equal(down.env.MEM_WHEEL, "-3");
});

it("scales Retina screenshot pixels to screen points", () => {
  // The agent saw a 1280-wide image of a 1512-point screen.
  assert.equal(factor, 1512 / 1280);
  const click = acts({ action: "click", x: 240, y: 120 });
  assert.equal(click.env.MEM_X, String(Math.round(240 * (1512 / 1280) * 100) / 100));
  assert.equal(click.env.MEM_Y, String(Math.round(120 * (1512 / 1280) * 100) / 100));
  // On a non-downscaled screenshot a Retina pixel is half a point.
  const identity = expectInfo("640 400 1280 800");
  const move = macActPlan({ action: "move", x: 200, y: 100 }, macPointFactor(identity));
  if (typeof move !== "string") {
    assert.equal(move.env.MEM_X, "100");
    assert.equal(move.env.MEM_Y, "50");
  }
});

it("keeps typed text out of the program and clears newlines to Return", () => {
  const sneaky = 'one\ntwo; $(danger) "quoted" back\\slash';
  const plan = acts({ action: "type", text: sneaky });
  for (const fragment of ["danger", "one", "two", "quoted", "slash"]) {
    assert.notInclude(plan.argv.join(" "), fragment);
  }
  assert.deepEqual(
    plan.env.MEM_TYPE_TEXT?.split("\r"),
    ["one", 'two; $(danger) "quoted" back\\slash'].map((part) => part.replace("\n", "")),
  );
  assert.equal(plan.env.MEM_TYPE_TEXT, 'one\rtwo; $(danger) "quoted" back\\slash');
});

it("translates key combinations into codes, chars and environment modifiers", () => {
  assert.deepEqual(macKeyEvent("enter"), { keyCode: 36, modifiers: [] });
  assert.deepEqual(macKeyEvent("ctrl+c"), { char: "c", modifiers: ["control"] });
  assert.deepEqual(macKeyEvent("cmd+shift+t"), { char: "t", modifiers: ["command", "shift"] });
  assert.deepEqual(macKeyEvent("f12"), { keyCode: 111, modifiers: [] });
  assert.equal(macKeyEvent("hyper+c"), undefined);
  assert.equal(macKeyEvent("notakey"), undefined);
  const key = acts({ action: "key", text: "ctrl+c" });
  assert.equal(key.env.MEM_ACTION, "key");
  assert.equal(key.env.MEM_KEY_CHAR, "c");
  assert.equal(key.env.MEM_KEY_MODIFIERS, "control");
  assert.equal(key.env.MEM_KEY_CODE, "");
  const named = acts({ action: "key", text: "escape" });
  assert.equal(named.env.MEM_KEY_CODE, "53");
  assert.equal(named.env.MEM_KEY_CHAR, "");
});

it("explains missing arguments with the same messages as Windows", () => {
  const cases: ReadonlyArray<readonly [ComputerActInput, string]> = [
    [{ action: "click" }, "`click` needs x and y."],
    [{ action: "type" }, "`type` needs text."],
    [{ action: "key", text: "" }, "`key` needs text."],
    [{ action: "scroll", x: 1, y: 1 }, "`scroll` needs amount."],
    [{ action: "scroll", amount: 2 }, "`scroll` needs x and y."],
    [{ action: "key", text: "hyper+z" }, "Unknown key combination: hyper+z"],
  ];
  for (const [input, message] of cases) assert.equal(macActPlan(input, factor), message);
});

it("reads the fixed program's status line", () => {
  assert.deepEqual(interpretMacAction("OK\n"), { kind: "ok" });
  assert.deepEqual(interpretMacAction("PERMISSION:Accessibility"), {
    kind: "permission",
    permission: "accessibility",
  });
  assert.deepEqual(interpretMacAction("PERMISSION:Screen Recording"), {
    kind: "permission",
    permission: "screen-recording",
  });
  assert.deepEqual(interpretMacAction("UNSUPPORTED:CGEvent"), {
    kind: "unsupported",
    what: "CGEvent",
  });
  assert.deepEqual(interpretMacAction("nothing"), { kind: "bad" });
});

it("builds screencapture and sips arguments without a shell", () => {
  assert.equal(MAC_SIPS, "/usr/bin/sips");
  assert.deepEqual(macSipsArguments(832, 1280, "/tmp/in.png", "/tmp/out.png"), [
    "-z",
    "832",
    "1280",
    "/tmp/in.png",
    "--out",
    "/tmp/out.png",
  ]);
  assert.isTrue(MAC_INFO_ARGUMENTS[0] === "/usr/bin/osascript");
});

it("downscales by width only, like the Windows screenshot", () => {
  assert.deepEqual(macResizePlan(3024, 1964), { width: 1280, height: 831, scale: 1280 / 3024 });
  assert.deepEqual(macResizePlan(1920, 1080), { width: 1280, height: 720, scale: 2 / 3 });
  assert.deepEqual(macResizePlan(1280, 720), { width: 1280, height: 720, scale: 1 });
});

it("reads PNG header dimensions and rejects everything else", () => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(3024, 0);
  header.writeUInt32BE(1964, 4);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(8),
    header,
  ]);
  assert.deepEqual(pngDimensions(png), { width: 3024, height: 1964 });
  assert.equal(pngDimensions(Buffer.alloc(30)), undefined);
  assert.equal(pngDimensions(Buffer.alloc(0)), undefined);
});

it("parses the measure probe output", () => {
  assert.deepEqual(parseMacInfo("1512 982 3024 1964\r\n"), {
    kind: "info",
    info: { pointWidth: 1512, pointHeight: 982, pixelWidth: 3024, pixelHeight: 1964 },
  });
  assert.deepEqual(parseMacInfo("PERMISSION:Screen Recording"), {
    kind: "permission",
    permission: "screen-recording",
  });
  assert.equal(parseMacInfo("1512 982 3024"), undefined);
  assert.equal(parseMacInfo("NaN 982 3024 1964"), undefined);
  assert.equal(parseMacInfo(""), undefined);
});
