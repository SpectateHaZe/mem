import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  belongsToSidebarSurface,
  filterSidebarSurfaceProjectGroups,
  filterSidebarSurfaceThreads,
  scratchProjectKeysOf,
} from "./sidebarSurface";

const local = EnvironmentId.make("environment-local");
const scratchProjectId = ProjectId.make("project-scratch");
const repoProjectId = ProjectId.make("project-repo");

function project(id: string, isScratch = false) {
  return { id, environmentId: local, ...(isScratch ? { isScratch: true as const } : {}) };
}

function thread(projectId: ProjectId, memMaster = false) {
  return {
    id: `thread:${projectId}`,
    environmentId: local,
    projectId,
    source: memMaster ? { memMaster: true } : {},
  };
}

const chat = thread(scratchProjectId);
const work = thread(repoProjectId);
const memMaster = thread(repoProjectId, true);
const scratchProjectKeys = scratchProjectKeysOf([
  project(scratchProjectId, true),
  project(repoProjectId),
]);

describe("sidebar surfaces", () => {
  it("splits scratch threads from repository threads", () => {
    expect(filterSidebarSurfaceThreads([chat, work], "chats", scratchProjectKeys)).toEqual([chat]);
    expect(filterSidebarSurfaceThreads([chat, work], "code", scratchProjectKeys)).toEqual([work]);
  });

  it("keeps the Mem master thread out of both surfaces", () => {
    expect(belongsToSidebarSurface(memMaster, "chats", scratchProjectKeys)).toBe(false);
    expect(belongsToSidebarSurface(memMaster, "code", scratchProjectKeys)).toBe(false);
  });

  it("drops every project group from Chats and the all-scratch group from Code", () => {
    const chats = { memberProjectRefs: [{ environmentId: local, projectId: scratchProjectId }] };
    const repository = { memberProjectRefs: [{ environmentId: local, projectId: repoProjectId }] };
    const groups = [chats, repository];

    expect(filterSidebarSurfaceProjectGroups(groups, "chats", scratchProjectKeys)).toEqual([]);
    expect(filterSidebarSurfaceProjectGroups(groups, "code", scratchProjectKeys)).toEqual([
      repository,
    ]);
  });
});
