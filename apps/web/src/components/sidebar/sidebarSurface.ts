import { isMemMasterThread } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * The sidebar's two surfaces. Code is the project view; Chats is quick chats only,
 * so the two never share a list.
 */
export type SidebarSurface = "chats" | "code";

export const SIDEBAR_SURFACES = ["chats", "code"] as const;

export const sidebarSurfaceSchema = Schema.Literals(SIDEBAR_SURFACES);

/** Local, per-client choice; not a server setting. */
export const SIDEBAR_SURFACE_STORAGE_KEY = "t3code:sidebar:surface";

export const DEFAULT_SIDEBAR_SURFACE: SidebarSurface = "code";

type SurfaceProject = {
  readonly environmentId: string;
  readonly id: string;
  readonly isScratch?: true | undefined;
};

type SurfaceThread = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly source: { readonly memMaster?: boolean | undefined };
};

type SurfaceProjectGroup = {
  readonly memberProjectRefs: ReadonlyArray<{
    readonly environmentId: string;
    readonly projectId: string;
  }>;
};

function scopedProjectKeyAt(environmentId: string, projectId: string): string {
  return `${environmentId}:${projectId}`;
}

/** Each environment's scratch workspace; its threads are quick chats. */
export function scratchProjectKeysOf(projects: ReadonlyArray<SurfaceProject>): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const project of projects) {
    if (project.isScratch === true) {
      keys.add(scopedProjectKeyAt(project.environmentId, project.id));
    }
  }
  return keys;
}

function isScratchProjectGroup(
  group: SurfaceProjectGroup,
  scratchProjectKeys: ReadonlySet<string>,
): boolean {
  return (
    group.memberProjectRefs.length > 0 &&
    group.memberProjectRefs.every((ref) =>
      scratchProjectKeys.has(scopedProjectKeyAt(ref.environmentId, ref.projectId)),
    )
  );
}

/**
 * The Mem master thread never joins a list; it renders as its own card above both
 * surfaces. Every other thread is a chat or repo thread by its project.
 */
export function belongsToSidebarSurface(
  thread: SurfaceThread,
  surface: SidebarSurface,
  scratchProjectKeys: ReadonlySet<string>,
): boolean {
  if (isMemMasterThread(thread.source)) return false;
  const isChat = scratchProjectKeys.has(scopedProjectKeyAt(thread.environmentId, thread.projectId));
  return surface === "chats" ? isChat : !isChat;
}

export function filterSidebarSurfaceThreads<T extends SurfaceThread>(
  threads: readonly T[],
  surface: SidebarSurface,
  scratchProjectKeys: ReadonlySet<string>,
): T[] {
  return threads.filter((thread) => belongsToSidebarSurface(thread, surface, scratchProjectKeys));
}

/** Chats have no project grouping; Code keeps every group that is not all scratch. */
export function filterSidebarSurfaceProjectGroups<T extends SurfaceProjectGroup>(
  groups: readonly T[],
  surface: SidebarSurface,
  scratchProjectKeys: ReadonlySet<string>,
): T[] {
  return surface === "chats"
    ? []
    : groups.filter((group) => !isScratchProjectGroup(group, scratchProjectKeys));
}
