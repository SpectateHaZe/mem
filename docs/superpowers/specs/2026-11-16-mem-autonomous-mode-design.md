# Mem autonomous mode

## Why

The owner wants to switch Mem on and walk away: Mem keeps improving every project the owner marked
in progress, round after round, until the owner switches it off. Today Mem steers a thread only
until it accepts the result, then marks the thread complete and stops.

## What the owner decided

- **One toggle, "Autonomous"**, on Mem's overseer settings. On: Mem works without pause. Off: it
  stops. Nothing else turns it off.
- **Scope: threads marked in progress.** (The lifecycle mark is per thread, not per project; a
  project is "in progress" through its in-progress threads.) Mem does not create projects.
- **After an accepted round, keep going:** the next round is always "find an improvement to how this
  app looks or works" and do it.
- **Out of usage: wait for the limit to reset**, then continue on its own. Never stop for it.
- **Commit, never push.** Each accepted round is committed. Nothing is pushed, tagged or released.

## How it fits the existing overseer

`MemOverseerService.runThread` already runs each in-progress thread through
claimed → review → (guide with a correction | accept | escalate | park). Autonomous mode changes
four things and leaves the rest alone:

1. **Always act.** While autonomous is on, the tick treats the owner as away (`ownerAway = true`), so
   Mem sends its own instructions instead of proposing them. Autonomous requires `enabled`; turning
   autonomous on turns `enabled` on.
2. **Accept starts the next round instead of completing.** On `accept`, instead of `ports.complete`
   (which sets the lifecycle to complete):
   1. Commit the round (below).
   2. Record a one-line summary of the round on the task record (keep the last 10).
   3. Reset the task to a fresh `claimed` round (rejections 0, no pending approval) and deliver the
      improvement instruction.
3. **Limits wait instead of parking.** A spending-cap refusal or an exhausted usage limit leaves the
   task `claimed` with a `waitingUntilMs`; ticks before that time skip the thread. `parked` is not
   used while autonomous is on.
4. **A status line** the toggle shows: working on N threads / waiting for the usage limit until
   <time> / waiting for the spending cap until <time>.

Unchanged: rejection rounds and the reject-loop guard (an agent that keeps failing review still
escalates to the owner and Mem moves on to other threads); the destructive-deletion approval
(still blocks and waits for the owner); the per-thread actor lock; a working thread is never
interrupted.

### The improvement instruction

Sent at the start of every new round. Roughly:

> Find the single most valuable improvement to how this app looks or works, the way its owner
> would want it. Make it one small, reviewable change, check it works (tests, typecheck, and look at
> it if it's UI), and say in one line what you improved. Don't repeat or undo these recent rounds:
> <last summaries>. Don't push, tag, release, or change anything outside this project.

The recent-round list is what keeps rounds from looping on the same idea.

### Committing a round

Mem commits, not the agent, so it is deterministic:

- Stage exactly the files the round touched (`thread.files`), by explicit path, never `git add -A`.
- The message is the round's one-line summary (the agent's own "what I improved" line, else the
  review's reasoning), followed by the repo's usual attribution line.
- The commit goes on whatever branch the thread's workspace is on. No branch is created.
- Hooks run. If a hook fails, the hook output goes back to the agent as the next instruction
  (the round is not accepted yet), and it counts as a rejection.
- Nothing to commit is fine: the agent may have committed itself. (Changed while building: counting
  it as a rejection would loop on agents that commit their own work.)
- Only the named paths are committed (`git commit -- <paths>`), so nothing the owner had staged is
  swept into Mem's commit.
- Never push.

### Waiting out a usage limit

A round can't run when the thread's provider is out of usage. Mem detects it two ways:

- the provider's usage windows (`providerUsageLimits`: `usedPercent`, `resetsAt`) show a window at
  100%, checked before Mem reviews or delivers; or
- the thread's last turn failed with a usage-limit error.

Mem then sets `waitingUntilMs` to the window's `resetsAt` plus 2 minutes, or 30 minutes from now if
the reset time is unknown, and tries again then. The same applies to Mem's own review model: if the
review can't run for lack of usage, the thread waits rather than escalating. Mem never switches the
thread to another model or provider to get around a limit.

### Priority (added by the owner during the build)

Each in-progress session has a Mem priority, high / normal / low (default normal), set from the
session's status menu under **Mem priority**. Mem handles sessions in priority order every tick,
and while a session's provider has a usage window at 90% or more, only sessions at the highest
priority present start new rounds; the rest wait until usage drops.

### The spending cap

The daily cap still applies (it is the owner's money brake). Reaching it waits (retrying every 30
minutes) until enough spend has aged out of the 24-hour window, then continues. In autonomous mode a
session turn whose provider reported a cost of exactly $0 (a subscription) is booked at $0, not at
the $0.25 estimate, so subscription work is bounded by the subscription's own limits.

## Turning it off

Off stops all new instructions at once. A turn already running finishes (cutting an agent off
mid-edit can leave broken code); its result is not reviewed or committed until autonomous or the
overseer runs again. Waiting threads stop waiting.

## Calls I made (the owner can change any of these)

- Off lets the running turn finish rather than interrupting it.
- Mem commits, the agent doesn't; staged by the thread's touched files.
- Commit on the current branch, no new branch.
- Escalation and the destructive-change approval stay on in autonomous mode.
- Recent-round memory is the last 10 summaries.
- Reset wait is `resetsAt` + 2 min, else retry every 30 min.

## Not in scope

Pushing, releases, opening PRs, creating projects or threads, picking which threads are in progress,
working on threads not marked in progress.

## Builder notes

- `packages/contracts/src/memOverseer.ts` currently has another session's uncommitted work; add the
  new setting without committing theirs (stage only your hunks).
- New settings field: `autonomous: Boolean` (decode default false) on `MemOverseerSettings`.
- New task-record fields: `waitingUntilMs: NullOr(Number)`, `roundSummaries: Array(String)`
  (decode defaults, so existing records still load).
- The UI toggle belongs next to the existing "enabled" switch in Mem's overseer settings.
- Tests: the reducer/loop decisions are pure (`MemOverseerLoop.ts`) — cover accept → new round,
  limit → wait, cap → wait, hook failure → rejection, nothing changed → rejection, off → no
  delivery.
