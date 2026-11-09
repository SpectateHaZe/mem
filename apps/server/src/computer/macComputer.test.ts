import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { MacComputerError, macPermissionMessages } from "./macComputer.ts";

it("maps each permission to a message naming it and where to grant it", () => {
  for (const message of Object.values(macPermissionMessages)) {
    assert.include(message, "System Settings");
    assert.include(message, "Privacy & Security");
  }
  assert.include(macPermissionMessages["screen-recording"], "Screen Recording");
  assert.include(macPermissionMessages.accessibility, "Accessibility");
});

it("carries the handler's failure code with its detail", () => {
  const error = new MacComputerError({ code: "capability_denied", detail: "no" });
  assert.equal(error.code, "capability_denied");
  assert.equal(error.detail, "no");
  assert.equal(error.message, "no");
  const isThisOne = Schema.is(MacComputerError);
  assert.isTrue(isThisOne(error));
  assert.isFalse(isThisOne(new Error("no")));
});
