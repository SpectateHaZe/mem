import { expect, it } from "vite-plus/test";

import { antigravityCliTarget, parseAntigravityCliRelease } from "./antigravityCliRelease.ts";

const URL_BASE = "https://storage.googleapis.com/antigravity-public/antigravity-cli";
const SHA512 = "a".repeat(128);

const manifest = (overrides: Record<string, unknown> = {}) => ({
  version: "1.5.7",
  url: `${URL_BASE}/1.5.7-123/linux-x64/cli_linux_x64.tar.gz`,
  sha512: SHA512,
  ...overrides,
});

it("reads a Linux release as a tarball with no harness sibling", () => {
  expect(parseAntigravityCliRelease(manifest(), "linux", "x64")).toEqual({
    version: "1.5.7",
    url: `${URL_BASE}/1.5.7-123/linux-x64/cli_linux_x64.tar.gz`,
    sha512: SHA512,
    executable: { name: "antigravity" },
    format: "tar.gz",
  });
});

it("reads a Windows release as a single executable", () => {
  const parsed = parseAntigravityCliRelease(
    manifest({ url: `${URL_BASE}/1.5.7-123/windows-x64/cli_windows_x64.exe` }),
    "win32",
    "x64",
  );
  expect(parsed).toMatchObject({
    executable: { name: "agy.exe" },
    format: "executable",
  });
});

it("refuses anything that is not the pinned host's own release", () => {
  // A download may only come from Google's bucket, for this platform's folder and file name.
  expect(
    parseAntigravityCliRelease(manifest({ url: "https://example.com/agy.exe" }), "linux", "x64"),
  ).toBeNull();
  expect(
    parseAntigravityCliRelease(
      manifest({ url: `${URL_BASE}/1.5.7-123/windows-x64/cli_windows_x64.exe` }),
      "linux",
      "x64",
    ),
  ).toBeNull();
});

it("refuses pre-CLI releases and malformed checksums", () => {
  expect(parseAntigravityCliRelease(manifest({ version: "1.4.9" }), "linux", "x64")).toBeNull();
  expect(parseAntigravityCliRelease(manifest({ sha512: "nope" }), "linux", "x64")).toBeNull();
});

it("names the manifest target for supported systems only", () => {
  expect(antigravityCliTarget("win32", "x64")).toBe("windows_amd64");
  expect(antigravityCliTarget("linux", "arm64", true)).toBe("linux_arm64_musl");
  expect(antigravityCliTarget("darwin", "arm64")).toBe("darwin_arm64");
  expect(antigravityCliTarget("linux", "ia32")).toBeNull();
});
