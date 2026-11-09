import * as NodeAssert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import { resolveOpenCodeBinaryPath } from "./binaryPath.ts";

describe("OpenCode binary path resolution", () => {
  it("prefers the user's configured Binary path over the bundled binary", () => {
    NodeAssert.equal(
      resolveOpenCodeBinaryPath({
        configuredPath: "/usr/local/bin/opencode",
        bundledPath: "/resources/opencode/opencode",
        bundledPathExists: true,
      }),
      "/usr/local/bin/opencode",
    );
  });

  it("prefers a bundled binary over the configured command name fallback", () => {
    NodeAssert.equal(
      resolveOpenCodeBinaryPath({
        configuredPath: "opencode",
        bundledPath: "/resources/opencode/opencode",
        bundledPathExists: true,
      }),
      "/resources/opencode/opencode",
    );
  });

  it("uses the bundled binary when no other OpenCode exists", () => {
    NodeAssert.equal(
      resolveOpenCodeBinaryPath({
        configuredPath: undefined,
        bundledPath: "C:\\resources\\opencode\\opencode.exe",
        bundledPathExists: true,
      }),
      "C:\\resources\\opencode\\opencode.exe",
    );
  });

  it("falls back to PATH when the bundled binary is missing", () => {
    NodeAssert.equal(
      resolveOpenCodeBinaryPath({
        configuredPath: undefined,
        bundledPath: "/resources/opencode/opencode",
        bundledPathExists: false,
      }),
      undefined,
    );
    NodeAssert.equal(
      resolveOpenCodeBinaryPath({
        configuredPath: "opencode",
        bundledPath: undefined,
        bundledPathExists: false,
      }),
      "opencode",
    );
  });

  it("has no bundled binary in dev, so behavior stays on PATH", () => {
    NodeAssert.equal(
      resolveOpenCodeBinaryPath({
        configuredPath: "opencode",
        bundledPath: undefined,
        bundledPathExists: false,
      }),
      "opencode",
    );
  });
});
