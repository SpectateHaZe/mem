import { assert, describe, it } from "@effect/vitest";
import { DateTime } from "effect";

import { buildRuntimeInstructions, timeZoneLabel } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("leaves PR linking to a session that already carries it, and keeps runtime identity", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Antigravity",
      model: "gemini-3.8-flash",
      pullRequestLinking: false,
    });

    assert.include(instructions, "through the Antigravity harness, as gemini-3.8-flash.");
    assert.notInclude(instructions, "<pull_request_linking>");
  });

  it("links PRs the agent creates, takes over, or pushes to, and no others", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.include(instructions, "Link each PR you create, take over, or push to");
    assert.include(instructions, "every stack layer");
    assert.include(instructions, "Skip PRs you only read or review");
    assert.include(instructions, "If linking fails, say so.");
    assert.notInclude(instructions, "git log -1");
    assert.notInclude(instructions, "work on");
    // Listing linked PRs as an end-of-work check found nothing to add in audited threads.
    assert.notInclude(instructions, "list_thread_pull_requests");
  });

  it("waits on a PR only with the watch, never with a poll loop", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.notInclude(instructions, "Creation, pending checks, or a merge ask alone is not enough");
    assert.include(instructions, "Links and watches persist across pushes.");
    // The wake message itself carries the do-not-re-watch rule.
    assert.notInclude(instructions, "On a wake");
    assert.include(
      instructions,
      "Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch",
    );
    assert.notInclude(instructions, "merge it now");
    assert.include(instructions, "Otherwise act now or hand back.");
    assert.include(instructions, "then watch and end your turn");
    assert.include(instructions, "never watch, even if the brief says babysit");
    assert.include(
      instructions,
      "After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>.",
    );
    assert.include(
      instructions,
      "For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup.",
    );
    assert.include(instructions, "call unwatch_pull_request");
  });
});

describe("timeZoneLabel", () => {
  it("reports the zone's own offset at the given instant, so DST is right", () => {
    const winter = DateTime.makeUnsafe("2026-01-15T12:00:00Z");
    const summer = DateTime.makeUnsafe("2026-07-15T12:00:00Z");

    assert.strictEqual(timeZoneLabel("Europe/Helsinki", winter), "Europe/Helsinki (UTC+02:00)");
    assert.strictEqual(timeZoneLabel("Europe/Helsinki", summer), "Europe/Helsinki (UTC+03:00)");
    assert.strictEqual(timeZoneLabel("America/New_York", winter), "America/New_York (UTC-05:00)");
    assert.strictEqual(timeZoneLabel("America/New_York", summer), "America/New_York (UTC-04:00)");
  });

  it("keeps zones that never observe DST, half-hour offsets, and UTC itself", () => {
    const at = DateTime.makeUnsafe("2026-01-15T12:00:00Z");

    assert.strictEqual(timeZoneLabel("Asia/Kolkata", at), "Asia/Kolkata (UTC+05:30)");
    assert.strictEqual(timeZoneLabel("UTC", at), "UTC (UTC+00:00)");
  });
});

describe("runtime_info clock", () => {
  it("names the server machine's zone and tells the agent to convert UTC timestamps", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.include(instructions, `The server machine's local time zone is ${zone} (UTC+`);
    assert.include(
      instructions,
      "tool timestamps are UTC ISO-8601, so convert them to this zone before you report a clock time to the user.",
    );
    // Codex rejects newlines in an additionalContext value.
    assert.isFalse(/<runtime_info>[^<]*\n/.test(instructions));
  });

  it("carries the clock text even when the session already handles PR linking", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Antigravity",
      pullRequestLinking: false,
    });

    assert.include(instructions, "The server machine's local time zone is ");
  });
});
