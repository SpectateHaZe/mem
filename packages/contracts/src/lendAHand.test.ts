import { describe, expect, it } from "vite-plus/test";

import { decodeHandCode, encodeHandCode } from "./lendAHand.ts";

const SECRET = "s".repeat(43);

describe("hand codes", () => {
  it("round-trips a quick-tunnel endpoint", () => {
    const code = encodeHandCode({ url: "https://calm-river-12.trycloudflare.com", secret: SECRET });
    expect(code.startsWith("mem-hand-")).toBe(true);
    expect(decodeHandCode(`  ${code}\n`)).toEqual({
      url: "https://calm-river-12.trycloudflare.com",
      secret: SECRET,
    });
  });

  it("refuses codes that would point the helper anywhere but a quick tunnel", () => {
    for (const url of [
      "http://calm-river-12.trycloudflare.com",
      "https://localhost:3000",
      "https://evil.com/.trycloudflare.com",
      "https://trycloudflare.com.evil.com",
    ]) {
      expect(decodeHandCode(encodeHandCode({ url, secret: SECRET }))).toBeNull();
    }
  });

  it("refuses short secrets and garbage", () => {
    expect(
      decodeHandCode(encodeHandCode({ url: "https://a.trycloudflare.com", secret: "short" })),
    ).toBeNull();
    expect(decodeHandCode("mem-hand-%%%")).toBeNull();
    expect(decodeHandCode("hello")).toBeNull();
  });
});
