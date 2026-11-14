import { describe, expect, it } from "vite-plus/test";

import { tunnelUrlIn } from "./cloudflared.ts";
import { bearerMatches } from "./HandHost.ts";

describe("Lend a Hand host", () => {
  it("accepts only the exact bearer secret", () => {
    expect(bearerMatches("Bearer abc123", "abc123")).toBe(true);
    expect(bearerMatches("Bearer abc124", "abc123")).toBe(false);
    expect(bearerMatches("Bearer abc1234", "abc123")).toBe(false);
    expect(bearerMatches("abc123", "abc123")).toBe(false);
    expect(bearerMatches(undefined, "abc123")).toBe(false);
  });

  it("reads the quick-tunnel address from cloudflared's log", () => {
    const log =
      "2026-11-14T10:00:00Z INF |  https://calm-river-12.trycloudflare.com                  |\n";
    expect(tunnelUrlIn(log)).toBe("https://calm-river-12.trycloudflare.com");
    expect(tunnelUrlIn("INF Requesting new quick Tunnel on trycloudflare.com...")).toBeUndefined();
  });
});
