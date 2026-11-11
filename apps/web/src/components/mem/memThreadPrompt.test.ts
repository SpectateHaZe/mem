import { describe, expect, it } from "vite-plus/test";

import { memThreadSeed, shortThreadId } from "./memThreadPrompt";

describe("shortThreadId", () => {
  it("keeps the id tail after its namespace separator", () => {
    expect(shortThreadId("thread:01J8Z4K6Q7")).toBe("01J8Z4K6");
    expect(shortThreadId("thread_abc")).toBe("abc");
  });

  it("keeps a bare id short and complete when it already fits", () => {
    expect(shortThreadId("3f9c2a1b")).toBe("3f9c2a1b");
    expect(shortThreadId("3f9c2a1b7d4e")).toBe("3f9c2a1b");
  });
});

describe("memThreadSeed", () => {
  it("names the thread and leaves the sentence open", () => {
    expect(memThreadSeed("Fix the flaky test", "thread:01J8Z4K6Q7")).toBe(
      'About "Fix the flaky test" (01J8Z4K6): ',
    );
  });

  it("falls back to an unnamed thread when the title is missing or blank", () => {
    expect(memThreadSeed(null, "thread:01J8Z4K6Q7")).toBe('About "this thread" (01J8Z4K6): ');
    expect(memThreadSeed("   ", "thread:01J8Z4K6Q7")).toBe('About "this thread" (01J8Z4K6): ');
  });
});
