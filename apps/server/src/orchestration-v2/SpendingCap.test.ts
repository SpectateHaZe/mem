import { assert, it } from "@effect/vitest";

import { localUsageDay } from "./SpendingCap.ts";
import { spendingCapHit, startsWork } from "./SpendingCapState.ts";

it("hits the cap at exactly the limit and never when the cap is off", () => {
  assert.equal(spendingCapHit(19.99, 20), undefined);
  assert.deepEqual(spendingCapHit(20, 20), { spentUsd: 20, capUsd: 20 });
  assert.equal(spendingCapHit(1_000, null), undefined);
});

it("uses the local calendar day around midnight UTC", () => {
  const justAfterUtcMidnight = Date.UTC(2026, 10, 9, 0, 30);
  assert.equal(localUsageDay(justAfterUtcMidnight, "UTC"), "2026-11-09");
  assert.equal(localUsageDay(justAfterUtcMidnight, "America/New_York"), "2026-11-08");
});

it("treats only run creation as starting work", () => {
  const event = (type: string) => ({ type }) as Parameters<typeof startsWork>[0][number];
  assert.isTrue(startsWork([event("thread.updated"), event("run.created")]));
  assert.isTrue(startsWork([event("run-attempt.created")]));
  assert.isFalse(startsWork([event("thread.updated")]));
});
