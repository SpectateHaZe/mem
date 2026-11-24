import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type CoworkSession,
  type EnvironmentId,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
  Trash2Icon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  coworkDecisionSummary,
  coworkHasExtraDetails,
  coworkPhaseLabel,
  coworkTurnDetails,
  coworkTurnSummary,
  decisionLine,
  defaultCoworkAgents,
  modelOptions,
  speakerColor,
  validateCoworkSetup,
} from "./coworkLogic";

interface AgentDraft {
  readonly key: number;
  readonly optionKey: string;
  readonly label: string;
  readonly role: string;
}

function CoworkSetupForm({
  environmentId,
  sessionThreadId,
  initialTopic,
  onStarted,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionThreadId: ThreadId;
  readonly initialTopic: string;
  readonly onStarted: () => void;
  readonly onCancel: (() => void) | undefined;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const options = modelOptions(providers ?? []);
  const startCowork = useAtomCommand(serverEnvironment.startCowork, {
    label: "start cowork",
    failureTitle: "Couldn't launch cowork",
  });

  const [maxRounds, setMaxRounds] = useState("2");
  const [message, setMessage] = useState(initialTopic);
  const [busy, setBusy] = useState(false);
  const [chosenAgents, setAgents] = useState<ReadonlyArray<AgentDraft>>([]);

  // Models can finish loading after the pane opens; seed two equal peers once options exist.
  const defaults = defaultCoworkAgents(options);
  const effectiveAgents = (chosenAgents.length >= 2 ? chosenAgents : defaults).map((agent) => {
    if (agent.optionKey !== "") return agent;
    const fallback = options[agent.key % Math.max(1, options.length)];
    return fallback === undefined
      ? agent
      : { ...agent, optionKey: fallback.key, label: agent.label || fallback.label };
  });

  const rounds = Number(maxRounds);
  const problem = !canOperate
    ? "This connection cannot start cowork agents."
    : validateCoworkSetup({ message, rounds, agents: effectiveAgents });

  const patchAgent = (key: number, patch: Partial<AgentDraft>) =>
    setAgents(effectiveAgents.map((agent) => (agent.key === key ? { ...agent, ...patch } : agent)));

  const submit = async () => {
    if (problem !== null || busy) return;
    setBusy(true);
    const participants = effectiveAgents.flatMap((agent) => {
      const selection: ModelSelection | undefined = options.find(
        (option) => option.key === agent.optionKey,
      )?.modelSelection;
      return selection === undefined
        ? []
        : [
            {
              label: agent.label.trim(),
              ...(agent.role.trim() === "" ? {} : { role: agent.role.trim() }),
              modelSelection: selection,
            },
          ];
    });
    const result = await startCowork({
      environmentId,
      input: {
        sessionThreadId,
        participants,
        maxRounds: rounds,
        message: message.trim(),
      },
    });
    setBusy(false);
    if (result._tag === "Success") onStarted();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <UsersIcon className="size-4 text-muted-foreground" />
            <span>Launch equal peers in this session</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Runs hidden peer agents in the background (not shown in your sidebar) and summarizes
            each turn for you. Round 1 thinks in parallel; further rounds debate and decide
            together.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Peers</Label>
          {effectiveAgents.map((agent) => (
            <div key={agent.key} className="flex flex-wrap items-center gap-1.5">
              <div className="min-w-36 flex-1">
                <Select
                  value={agent.optionKey}
                  onValueChange={(value) => {
                    const option = options.find((candidate) => candidate.key === value);
                    if (option !== undefined) {
                      patchAgent(agent.key, { optionKey: option.key, label: option.label });
                    }
                  }}
                >
                  <SelectTrigger aria-label="Peer model">
                    <SelectValue>
                      {options.find((option) => option.key === agent.optionKey)?.description ??
                        "Choose a model"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {options.map((option) => (
                      <SelectItem key={option.key} value={option.key}>
                        {option.description}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="w-24">
                <Input
                  aria-label="Peer name for @mentions"
                  value={agent.label}
                  onChange={(event) => patchAgent(agent.key, { label: event.target.value })}
                  placeholder="Name"
                />
              </div>
              <div className="w-28">
                <Input
                  aria-label="Peer perspective"
                  value={agent.role}
                  onChange={(event) => patchAgent(agent.key, { role: event.target.value })}
                  placeholder="Focus (opt.)"
                />
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Remove peer"
                disabled={effectiveAgents.length <= 2}
                onClick={() =>
                  setAgents(effectiveAgents.filter((other) => other.key !== agent.key))
                }
              >
                <XIcon />
              </Button>
            </div>
          ))}
          <div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                const nextKey = Math.max(...effectiveAgents.map((agent) => agent.key), 0) + 1;
                const fallback = options[nextKey % Math.max(1, options.length)];
                setAgents([
                  ...effectiveAgents,
                  {
                    key: nextKey,
                    optionKey: fallback?.key ?? "",
                    label: fallback ? `${fallback.label}-${nextKey + 1}` : "",
                    role: "",
                  },
                ]);
              }}
            >
              <PlusIcon /> Add peer
            </Button>
          </div>
        </div>

        <div className="flex items-end gap-3">
          <div className="grid w-24 gap-1.5">
            <Label htmlFor="cowork-rounds">Rounds</Label>
            <Input
              id="cowork-rounds"
              inputMode="numeric"
              value={maxRounds}
              onChange={(event) => setMaxRounds(event.target.value)}
            />
          </div>
          <p className="pb-1.5 text-xs text-muted-foreground">
            {rounds >= 2
              ? "Round 1 thinks in parallel; rounds 2+ converge."
              : "1 quick round-table pass."}
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="cowork-topic">What should they think through and decide?</Label>
          <Textarea
            id="cowork-topic"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Describe the question, architecture trade-off, or bug to solve together…"
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </div>

        {problem === null ? null : <p className="text-xs text-muted-foreground">{problem}</p>}

        <div className="flex justify-end gap-2">
          {onCancel === undefined ? null : (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button size="sm" disabled={problem !== null || busy} onClick={() => void submit()}>
            Launch cowork
          </Button>
        </div>
      </div>
    </div>
  );
}

function CoworkActiveView({
  environmentId,
  session,
  spentTodayUsd,
  onRestart,
  onSendToSession,
  onInsertInComposer,
}: {
  readonly environmentId: EnvironmentId;
  readonly session: CoworkSession;
  readonly spentTodayUsd: number;
  readonly onRestart: () => void;
  readonly onSendToSession: (text: string) => Promise<void>;
  readonly onInsertInComposer: (text: string) => void;
}) {
  const settings = usePrimarySettings();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const send = useAtomCommand(serverEnvironment.sendToCowork, {
    label: "message cowork",
    failureTitle: "Couldn't send message to cowork",
  });
  const setPaused = useAtomCommand(serverEnvironment.setCoworkPaused, {
    label: "pause cowork",
    failureTitle: "Couldn't pause or resume cowork",
  });
  const remove = useAtomCommand(serverEnvironment.deleteCowork, {
    label: "delete cowork",
    failureTitle: "Couldn't remove cowork",
  });

  const [draft, setDraft] = useState("");
  const [sendingDecision, setSendingDecision] = useState(false);
  const [showFullReplies, setShowFullReplies] = useState(false);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());

  const toggleExpanded = (id: string) =>
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const cap = settings.dailySpendCapUsd;
  const activeSpeaker =
    session.speakerIndex === null ? null : session.participants[session.speakerIndex];
  const decision = coworkDecisionSummary(session);
  const phaseBadgeVariant =
    session.phase === "decided" ? "success" : session.phase === "paused" ? "warning" : "info";

  const submitFollowUp = () => {
    const message = draft.trim();
    if (message === "" || !canOperate) return;
    setDraft("");
    void send({
      environmentId,
      input: { sessionThreadId: session.sessionThreadId, message },
    }).then((result) => {
      if (result._tag !== "Success") {
        setDraft((current) => (current === "" ? message : current));
      }
    });
  };

  const handleSendDecision = async () => {
    if (decision === null || sendingDecision) return;
    setSendingDecision(true);
    try {
      await onSendToSession(`Cowork decision:\n\n${decision}`);
      toastManager.add({ type: "success", title: "Sent cowork decision to session" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't send decision to session",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setSendingDecision(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
        <Badge variant={phaseBadgeVariant} size="sm">
          {coworkPhaseLabel(session)}
        </Badge>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {session.participants.map((peer) => (
            <Tooltip key={peer.threadId}>
              <TooltipTrigger
                render={
                  <Link
                    to="/$environmentId/$threadId"
                    params={buildThreadRouteParams(scopeThreadRef(environmentId, peer.threadId))}
                    className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                  />
                }
              >
                {peer.status === "thinking" ? (
                  <span className="size-1.5 rounded-full bg-info" aria-hidden />
                ) : peer.status === "error" ? (
                  <span className="size-1.5 rounded-full bg-destructive" aria-hidden />
                ) : null}
                <span>{peer.label}</span>
                {peer.role ? <span className="opacity-70">· {peer.role}</span> : null}
                <ArrowUpRightIcon className="size-3 opacity-60" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                Open {peer.label}&apos;s peer thread ({peer.modelSelection.model})
              </TooltipPopup>
            </Tooltip>
          ))}
        </div>
        {session.phase !== "decided" ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!canOperate}
            onClick={() =>
              void setPaused({
                environmentId,
                input: {
                  sessionThreadId: session.sessionThreadId,
                  paused: session.phase !== "paused",
                },
              })
            }
          >
            {session.phase === "paused" ? <PlayIcon /> : <PauseIcon />}
            {session.phase === "paused" ? "Resume" : "Pause"}
          </Button>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setShowFullReplies((current) => !current)}
              />
            }
          >
            {showFullReplies ? "Summaries only" : "Full replies"}
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {showFullReplies
              ? "Show concise turn summaries written for you"
              : "Expand every peer's full technical notes"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="New cowork"
                disabled={!canOperate}
                onClick={onRestart}
              />
            }
          >
            <RotateCcwIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Start a new cowork in this session</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Delete cowork"
                disabled={!canOperate}
                onClick={async () => {
                  const message =
                    "Clear this cowork discussion?\nIts hidden peer threads will also be cleaned up.";
                  const confirmed =
                    (await requestConfirmDialog(message, { variant: "destructive" })) ??
                    window.confirm(message);
                  if (!confirmed) return;
                  await remove({
                    environmentId,
                    input: { sessionThreadId: session.sessionThreadId },
                  });
                }}
              />
            }
          >
            <Trash2Icon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Clear cowork</TooltipPopup>
        </Tooltip>
      </div>

      <div className="scrollbar-gutter-both flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
        <div className="flex flex-col gap-3 p-3">
          {session.transcript.map((message) => {
            const inlineDecision = decisionLine(message.text);
            const summary = coworkTurnSummary(message);
            const details = coworkTurnDetails(message);
            const hasDetails = coworkHasExtraDetails(message);
            const isExpanded = showFullReplies || expandedIds.has(message.id);
            const visibleText = isExpanded ? details || summary : summary;
            return (
              <div
                key={message.id}
                className="flex flex-col gap-1.5 rounded-lg border border-border/50 bg-card/40 px-3 py-2.5"
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="text-xs font-semibold"
                    style={{ color: speakerColor(message.speaker) }}
                  >
                    {message.speaker}
                  </span>
                  {message.kind === "thought" ? (
                    <span className="text-2xs text-muted-foreground">Round 1 · Independent</span>
                  ) : message.kind === "deliberation" ? (
                    <span className="text-2xs text-muted-foreground">
                      Round {message.round} · Deliberation
                    </span>
                  ) : null}
                  {hasDetails && !showFullReplies ? (
                    <button
                      type="button"
                      className="ms-auto cursor-pointer text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() => toggleExpanded(message.id)}
                    >
                      {isExpanded ? "Hide details" : "Show details"}
                    </button>
                  ) : null}
                </div>
                {visibleText !== "" ? <ChatMarkdown cwd={undefined} text={visibleText} /> : null}
                {inlineDecision === null ? null : (
                  <div className="rounded-md border-s-2 border-success bg-muted/50 px-3 py-1.5 text-sm">
                    <span className="font-medium">Decision:</span> {inlineDecision}
                  </div>
                )}
              </div>
            );
          })}

          {decision !== null && session.phase === "decided" ? (
            <div className="flex flex-col gap-2 rounded-md border bg-muted/35 p-3">
              <div className="text-xs font-medium text-foreground">Shared decision</div>
              <p className="whitespace-pre-wrap text-sm text-foreground/90">{decision}</p>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="xs"
                  disabled={sendingDecision || !canOperate}
                  onClick={() => void handleSendDecision()}
                >
                  <SendIcon />
                  Send to session
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onInsertInComposer(`Cowork decision:\n\n${decision}`)}
                >
                  Insert in composer
                </Button>
              </div>
            </div>
          ) : null}

          <p className="text-xs text-muted-foreground" role="status">
            {session.note ??
              (session.phase === "thinking"
                ? `Thinking in parallel (${session.participants.filter((p) => p.status === "done").length}/${session.participants.length} ready)…`
                : session.phase === "deliberating" && activeSpeaker
                  ? `${activeSpeaker.label} is replying…`
                  : session.phase === "decided"
                    ? "Peers finished deliberating."
                    : "Paused.")}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t p-3">
        <Textarea
          aria-label="Message cowork peers"
          value={draft}
          disabled={!canOperate}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submitFollowUp();
            }
          }}
          placeholder="Message the team, or @mention a peer…"
        />
        <div className="flex items-center justify-between text-2xs text-muted-foreground">
          <span>
            ~${spentTodayUsd.toFixed(2)} {cap === null ? "today" : `of $${cap.toFixed(2)} today`}
          </span>
          <span>Enter to send</span>
        </div>
      </div>
    </div>
  );
}

export default function CoworkPane({
  environmentId,
  threadId,
  prefillTopic,
  onConsumePrefill,
  onSendToSession,
  onInsertInComposer,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly prefillTopic?: string | null;
  readonly onConsumePrefill?: () => void;
  readonly onSendToSession: (text: string) => Promise<void>;
  readonly onInsertInComposer: (text: string) => void;
  readonly onClose: () => void;
}) {
  const query = useEnvironmentQuery(serverEnvironment.coworkLive({ environmentId, input: {} }));
  const session = query.data?.sessions.find((entry) => entry.sessionThreadId === threadId) ?? null;
  const spentTodayUsd = query.data?.spentTodayUsd ?? 0;
  const [restarting, setRestarting] = useState(false);

  return (
    <div data-cowork-pane className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
        <UsersIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {session ? `Cowork · ${session.topic}` : "Cowork"}
        </span>
        <Button variant="ghost" size="icon-xs" aria-label="Close cowork" onClick={onClose}>
          <XIcon />
        </Button>
      </div>

      {query.data === undefined ? (
        <p className="p-4 text-xs text-muted-foreground">Loading cowork…</p>
      ) : session === null || restarting ? (
        <CoworkSetupForm
          key={`${threadId}:${prefillTopic ?? ""}`}
          environmentId={environmentId}
          sessionThreadId={threadId}
          initialTopic={prefillTopic ?? ""}
          onStarted={() => {
            setRestarting(false);
            onConsumePrefill?.();
          }}
          onCancel={session === null ? undefined : () => setRestarting(false)}
        />
      ) : (
        <CoworkActiveView
          key={session.sessionThreadId}
          environmentId={environmentId}
          session={session}
          spentTodayUsd={spentTodayUsd}
          onRestart={() => setRestarting(true)}
          onSendToSession={onSendToSession}
          onInsertInComposer={onInsertInComposer}
        />
      )}
    </div>
  );
}
