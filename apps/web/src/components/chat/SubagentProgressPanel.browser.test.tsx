import { EnvironmentId, NodeId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  shells: new Map<string, unknown>(),
  children: new Map<string, unknown>(),
  environment: "remote" as unknown,
}));

vi.mock(import("../../state/entities"), () => ({
  useQuietThreadShell: ((ref: unknown) =>
    ref === null
      ? null
      : (state.shells.get((ref as { threadId: string }).threadId) ?? null)) as never,
  useQuietThreadProjection: ((ref: unknown) => {
    if (ref === null) return null;
    const threadId = (ref as { threadId: string }).threadId;
    if (threadId === "thread-test") {
      return state.projection === null
        ? null
        : ({ projection: state.projection, environmentId: "local" } as never);
    }
    return (state.children.get(threadId) ?? null) as never;
  }) as never,
}));

vi.mock(import("../../state/environments"), () => ({
  useEnvironment: ((id: unknown) => (id === null ? null : (state.environment ?? null))) as never,
}));

import { render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import type { SubagentTodoList } from "@t3tools/client-runtime/state/subagent-panel";
import { SubagentProgressPanel } from "./SubagentProgressPanel";

const environmentId = EnvironmentId.make("local");
const parentThreadId = ThreadId.make("thread-test");
const childAThreadId = ThreadId.make("child-a");
const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

const todoPlan: SubagentTodoList = {
  kind: "todo_list",
  id: "plan:fixture" as SubagentTodoList["id"],
  threadId: childAThreadId,
  runId: null,
  nodeId: "node:fixture" as unknown as SubagentTodoList["nodeId"],
  status: "active",
  steps: [
    { id: "1", text: "Read the code", status: "completed" },
    { id: "2", text: "Write the fix", status: "running" },
    { id: "3", text: "Run the tests", status: "pending" },
  ],
};

function agentFixture(overrides: Record<string, unknown>) {
  return {
    id: NodeId.make("task"),
    threadId: parentThreadId,
    runId: null,
    parentNodeId: NodeId.make("parent"),
    origin: "app_owned",
    createdBy: "agent",
    driver: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "Subagent task",
    title: "Subagent task",
    model: null,
    status: "running",
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    promptOmitted: true,
    resultOmitted: true,
    ...overrides,
  };
}

const activeShell = {
  runtime: { status: "running" },
  latestRun: null,
  blockedOnThreadWait: false,
  pendingBackgroundTasks: [],
  hasPendingApprovals: false,
  hasPendingUserInput: false,
};

function childProjection(overrides: Record<string, unknown> = {}) {
  return { environmentId, projection: { ...makeThreadProjectionFixture(), ...overrides } };
}

/** One working one-of-three task beside a finished task with no checklist. */
function setup() {
  state.shells = new Map([["child-a", activeShell]]);
  state.children = new Map([["child-a", childProjection({ plans: [todoPlan] })]]);
  state.environment = "remote";
  state.projection = {
    ...makeThreadProjectionFixture(),
    subagents: [
      agentFixture({
        id: NodeId.make("task-a"),
        childThreadId: childAThreadId,
        title: "Fix the login bug",
        model: "anthropic/claude-haiku",
        origin: "app_owned",
        status: "running",
      }),
      agentFixture({
        id: NodeId.make("task-b"),
        title: "Explore the repo",
        origin: "provider_native",
        driver: "claudeAgent",
        status: "completed",
        result: null,
        completedAt: now,
      }),
    ],
  };
}

it("renders nothing in a thread without subagents", async () => {
  setup();
  delete (state.projection as Record<string, unknown>).subagents;
  await using screen = await render(
    <SubagentProgressPanel environmentId={environmentId} threadId={parentThreadId} />,
  );
  expect(screen.container.querySelector("[data-subagents-progress-panel]")).toBeNull();
});

it("shows each task's bar from its real checklist, or No task list", async () => {
  setup();
  await using screen = await render(
    <SubagentProgressPanel environmentId={environmentId} threadId={parentThreadId} />,
  );
  const bar = screen.container.querySelector('[role="progressbar"]')!;
  expect(bar).not.toBeNull();
  expect(bar.getAttribute("aria-valuenow")).toBe("1");
  expect(bar.getAttribute("aria-valuemax")).toBe("3");
  await expect.element(page.getByText("1 of 3", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Working on: Write the fix", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Finished", { exact: true })).toBeVisible();
  await expect.element(page.getByText("No task list", { exact: true })).toBeVisible();
});

it("shows the task's model beside its title", async () => {
  setup();
  await using _screen = await render(
    <SubagentProgressPanel environmentId={environmentId} threadId={parentThreadId} />,
  );
  await expect.element(page.getByText("Fix the login bug", { exact: true })).toBeVisible();
  await expect.element(page.getByText("anthropic/claude-haiku", { exact: true })).toBeVisible();
});

it("reports a pending approval or question as Waiting on you", async () => {
  setup();
  state.shells = new Map([["child-a", { ...activeShell, hasPendingApprovals: true }]]);
  await using _screen = await render(
    <SubagentProgressPanel environmentId={environmentId} threadId={parentThreadId} />,
  );
  await expect.element(page.getByText("Waiting on you", { exact: true })).toBeVisible();
});

it("reports the awaited work it holds on as Waiting on", async () => {
  setup();
  state.shells = new Map([
    [
      "child-a",
      {
        ...activeShell,
        pendingBackgroundTasks: [
          { kind: "command", taskId: "t1", description: "npm ci", awaited: true },
        ],
      },
    ],
  ]);
  await using _screen = await render(
    <SubagentProgressPanel environmentId={environmentId} threadId={parentThreadId} />,
  );
  await expect.element(page.getByText("Waiting on: npm ci", { exact: true })).toBeVisible();
});

it("keeps a truly finished failed task from a lying Working on label", async () => {
  const plan: SubagentTodoList = { ...todoPlan, status: "active" };
  state.shells = new Map([["child-a", { ...activeShell, runtime: null }]]);
  state.children = new Map([["child-a", childProjection({ plans: [plan] })]]);
  state.projection = {
    ...makeThreadProjectionFixture(),
    subagents: [
      agentFixture({
        id: NodeId.make("task-a"),
        childThreadId: childAThreadId,
        title: "Fix the login bug",
        status: "failed",
      }),
    ],
  };
  await using screen = await render(
    <SubagentProgressPanel environmentId={environmentId} threadId={parentThreadId} />,
  );
  await expect.element(page.getByText("Finished · Failed", { exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toContain("Working on:");
});

it("collapses to its header and expands again", async () => {
  setup();
  await using screen = await render(
    <SubagentProgressPanel environmentId={environmentId} threadId={parentThreadId} />,
  );
  expect(screen.container.querySelector('[role="progressbar"]')).not.toBeNull();
  await screen.getByRole("button", { name: /Subagents/ }).click();
  await vi.waitFor(() => expect(screen.container.querySelector('[role="progressbar"]')).toBeNull());
  await expect.element(page.getByText("2", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: /Subagents/ }).click();
  await expect.element(page.getByText("1 of 3", { exact: true })).toBeVisible();
});

it("opens a delegated task's thread from its row", async () => {
  setup();
  await using screen = await render(
    <SubagentProgressPanel environmentId={environmentId} threadId={parentThreadId} />,
  );
  await screen.getByRole("button", { name: /Fix the login bug/ }).click();
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/local/child-a"));
});

it("opens a task that runs in a linked environment there", async () => {
  setup();
  const remoteEnvironmentId = EnvironmentId.make("remote-env");
  state.projection = {
    ...makeThreadProjectionFixture(),
    subagents: [
      agentFixture({
        id: NodeId.make("task-remote"),
        title: "Remote task",
        status: "running",
        remoteChild: {
          environmentId: remoteEnvironmentId,
          threadId: ThreadId.make("remote-thread"),
          label: "Remote VM",
        },
      }),
    ],
  };
  await using screen = await render(
    <SubagentProgressPanel environmentId={environmentId} threadId={parentThreadId} />,
  );
  await screen.getByRole("button", { name: /Remote task/ }).click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/remote-env/remote-thread"),
  );
});

it("keeps a task whose remote environment is unreachable from opening locally", async () => {
  setup();
  state.environment = null;
  state.projection = {
    ...makeThreadProjectionFixture(),
    subagents: [
      agentFixture({
        id: NodeId.make("task-remote"),
        title: "Remote task",
        status: "running",
        remoteChild: {
          environmentId: EnvironmentId.make("offline-env"),
          threadId: ThreadId.make("remote-thread"),
          label: "Offline VM",
        },
      }),
    ],
  };
  await using screen = await render(
    <SubagentProgressPanel environmentId={environmentId} threadId={parentThreadId} />,
  );
  await expect
    .element(screen.getByRole("button", { name: /Remote task/ }))
    .toHaveAttribute("aria-disabled", "true");
});
