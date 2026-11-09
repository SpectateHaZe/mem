import { assert, it } from "@effect/vitest";
import type { ComputerActInput } from "@t3tools/contracts";

import {
  actScript,
  comboToSendKeys,
  computerUseRefusal,
  escapeSendKeys,
  parseScreenshot,
} from "./computerScripts.ts";

it("escapes text so SendKeys types it literally", () => {
  assert.equal(escapeSendKeys("a+b (c) {d}^%~"), "a{+}b {(}c{)} {{}d{}}{^}{%}{~}");
  assert.equal(escapeSendKeys("one\ntwo"), "one{ENTER}two");
});

it("translates key combinations and rejects unknown ones", () => {
  assert.equal(comboToSendKeys("ctrl+c"), "^c");
  assert.equal(comboToSendKeys("ctrl+shift+Tab"), "^+{TAB}");
  assert.equal(comboToSendKeys("enter"), "{ENTER}");
  assert.equal(comboToSendKeys("f12"), "{F12}");
  assert.equal(comboToSendKeys("hyper+c"), undefined);
  assert.equal(comboToSendKeys("notakey"), undefined);
});

it("keeps typed text out of the script source", () => {
  const result = actScript({ action: "type", text: "$(rm -rf)" });
  assert.isObject(result);
  if (typeof result === "string") return;
  assert.equal(result.keys, "${(}rm -rf{)}");
  assert.notInclude(result.script, "rm -rf");
});

it("explains missing arguments", () => {
  const cases: ReadonlyArray<ComputerActInput> = [
    { action: "click" },
    { action: "type" },
    { action: "scroll", x: 1, y: 1 },
  ];
  for (const input of cases) assert.isString(actScript(input));
});

it("gates each mode", () => {
  assert.equal(computerUseRefusal("full", "win32", true), undefined);
  assert.equal(computerUseRefusal("view", "win32", false), undefined);
  assert.isString(computerUseRefusal("view", "win32", true));
  assert.isString(computerUseRefusal("off", "win32", false));
  assert.isString(computerUseRefusal("full", "linux", false));
});

it("parses screenshot output", () => {
  assert.deepEqual(parseScreenshot("1280 720 QUJD\r\n"), {
    width: 1280,
    height: 720,
    data: "QUJD",
  });
  assert.equal(parseScreenshot("error"), undefined);
});
