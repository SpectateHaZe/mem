import {
  CommandId,
  MessageId,
  RoomError,
  SubagentReportWatchInput,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { ENDED_RUN_STATUSES, subagentFinishedNote, subagentStartedNote } from "./roomModerator.ts";

const ReportsFile = Schema.fromJsonString(Schema.Array(SubagentReportWatchInput));
const decodeReports = Schema.decodeUnknownEffect(ReportsFile);
const encodeReports = Schema.encodeEffect(ReportsFile);

const reportError = (cause: unknown) =>
  new RoomError({ detail: cause instanceof Error ? cause.message : String(cause) });

export class SubagentReportService extends Context.Service<
  SubagentReportService,
  {
    /** Tells the parent the subagent started, then sends it the subagent's first result. */
    readonly watch: (input: SubagentReportWatchInput) => Effect.Effect<void, RoomError>;
  }
>()("t3/rooms/SubagentReportService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const filePath = path.join(config.stateDir, "subagent-reports.json");
  const lock = yield* Semaphore.make(1);

  const loaded = yield* fileSystem.readFileString(filePath).pipe(
    Effect.flatMap((contents) => decodeReports(contents)),
    Effect.orElseSucceed(() => [] as ReadonlyArray<SubagentReportWatchInput>),
  );
  const reports = new Map(loaded.map((report) => [report.childThreadId, report]));

  const persist = Effect.gen(function* () {
    const contents = yield* encodeReports([...reports.values()]);
    yield* writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  }).pipe(Effect.mapError(reportError));

  const tellParent = (report: SubagentReportWatchInput, stage: string, text: string) => {
    // Stable ids, so a redelivery after a restart cannot post the note twice.
    const key = `subagent-report:${report.childThreadId}:${stage}`;
    return threads
      .sendToThread({
        projectId: report.projectId,
        commandId: CommandId.make(key),
        messageId: MessageId.make(key),
        threadId: report.parentThreadId,
        text,
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.mapError(reportError));
  };

  const deliverResult = Effect.fn("SubagentReportService.deliverResult")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
  ) {
    if (!ENDED_RUN_STATUSES.has(run.status)) return;
    const report = reports.get(threadId);
    if (report === undefined) return;
    const records = yield* projections
      .getThreadRecords(threadId, ["messages", "turnItems"])
      .pipe(Effect.mapError(reportError));
    const result = subagentResultForRun(records, run).text;
    yield* tellParent(report, "finished", subagentFinishedNote(report.label, run.status, result));
    reports.delete(threadId);
    yield* persist;
  });

  const deliverIfEnded = Effect.fn("SubagentReportService.deliverIfEnded")(function* (
    threadId: ThreadId,
  ) {
    const { runs } = yield* projections
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.mapError(reportError));
    const latest = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
    if (latest !== undefined) yield* deliverResult(threadId, latest);
  });

  // A subagent that finished while the server was down never produces a live event.
  const recover = Effect.forEach(
    [...reports.keys()],
    (threadId) =>
      deliverIfEnded(threadId).pipe(
        lock.withPermit,
        Effect.catchCause((cause) =>
          Effect.logWarning("subagent-reports.recover-failed", { cause }),
        ),
      ),
    { discard: true },
  );

  yield* forkParked(
    recover.pipe(
      Effect.andThen(
        Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
          event.type === "run.updated"
            ? deliverResult(event.threadId, event.payload).pipe(
                lock.withPermit,
                Effect.catchCause((cause) =>
                  Effect.logWarning("subagent-reports.deliver-failed", { cause }),
                ),
              )
            : Effect.void,
        ),
      ),
    ),
  );

  return SubagentReportService.of({
    watch: Effect.fn("SubagentReportService.watch")(function* (input) {
      reports.set(input.childThreadId, input);
      yield* persist;
      yield* tellParent(input, "started", subagentStartedNote(input.label, input.task));
      // The client registers after starting the turn, which may already have failed.
      yield* deliverIfEnded(input.childThreadId);
    }, lock.withPermit),
  });
});

export const layer = Layer.effect(SubagentReportService, make);
