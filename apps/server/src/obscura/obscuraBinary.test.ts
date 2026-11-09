import { assert, it } from "@effect/vitest";

import { limitContent, obscuraArgs } from "./obscuraBinary.ts";

it("passes only normalized web URLs to the browser", () => {
  assert.deepEqual(obscuraArgs({ url: "https://example.com", dump: "links" }), [
    "fetch",
    "https://example.com/",
    "--dump",
    "links",
    "--obey-robots",
    "--quiet",
  ]);
  assert.equal(obscuraArgs({ url: "--proxy=http://evil" }), undefined);
  assert.equal(obscuraArgs({ url: "file:///C:/secrets.txt" }), undefined);
});

it("flags content past the limit", () => {
  assert.deepEqual(limitContent("short"), { content: "short", truncated: false });
  const limited = limitContent("x".repeat(100_001));
  assert.equal(limited.content.length, 100_000);
  assert.isTrue(limited.truncated);
});
