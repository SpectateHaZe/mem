import { assert, describe, it } from "@effect/vitest";

import { isCreditExhaustionFailure } from "./delegatedTaskCredit.ts";

describe("isCreditExhaustionFailure", () => {
  it.each([
    "Insufficient Balance (request_id: req_123)",
    "Upstream request failed: Insufficient account funds",
    "insufficient_quota",
    "You exceeded your current quota, please check your plan and billing details.",
    "Quota exhausted for this account.",
    "You are out of credits.",
    "No remaining credits available.",
    "Your credit balance is too low to run this model.",
    "credit limit reached",
    "HTTP 402 Payment Required",
    "Please update your billing information.",
    "You have reached your Antigravity quota.",
    "You've reached your Gemini free-tier quota.",
    "RESOURCE_EXHAUSTED: Exceeded the daily quota for this key.",
    "insufficient_user_quota: the account is capped this month",
    "The request failed: insufficient account funds",
    "This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 812.",
    "Key limit exceeded (total limit)",
    "Billing hard limit has been reached",
    "You have reached your specified API usage limits. You will regain access on 2026-12-01.",
    "Quota exceeded for metric: GenerateRequestsPerDayPerProjectPerModel-FreeTier, and InputTokensPerModelPerMinute-FreeTier",
  ])("detects credit exhaustion in %s", (message) => {
    assert.isTrue(isCreditExhaustionFailure(message));
  });

  it.each([
    "Invalid request: this model does not support tools.",
    "Tool execution failed: ENOENT",
    "The operation was cancelled by the user.",
    "Rate limit exceeded. Try again later.",
    "Claude API rate limit reached. Try again later.",
    "Too Many Requests (429)",
    "insufficient_scope",
    "Insufficient disk space at /tmp",
    "You have insufficient permissions to access this file.",
    "Insufficient disk space at /tmp",
    "No credit card was required for the update.",
    "Their billing review found no changes to make.",
    "Run quota check succeeded: the account is in credit.",
    "Child task ended with status failed.",
    "RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Generate requests' and limit 'Generate requests per minute'.",
    "You exceeded your current quota. Quota exceeded for metric: GenerateRequestsPerMinutePerProjectPerModel. Please retry in 21s.",
    '{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}',
    "429 Resource exhausted. Please try again later.",
  ])("ignores non-credit failures in %s", (message) => {
    assert.isFalse(isCreditExhaustionFailure(message));
  });
});
