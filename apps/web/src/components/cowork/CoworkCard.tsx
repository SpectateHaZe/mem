import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type CoworkMode,
  type CoworkSession,
  type EnvironmentId,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import {
  addCoworkPeer,
  coworkDecisionSummary,
  coworkPeerLabel,
  coworkPhaseLabel,
  coworkTurnSummary,
  modelOptionKey,
  modelOptions,
  type CoworkPeerDraft,
  validateCoworkSetup,
} from "./coworkLogic";

const ROUND_CHOICES = ["1", "2", "3", "4", "5"];
const MODE_LABELS: Record<CoworkMode, string> = {
  brainstorm: "Brainstorm",
  code: "Code together",
};

function CoworkSetup({
  environmentId,
  sessionThreadId,
  sessionModelSelection,
  initialTopic,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionThreadId: ThreadId;
  readonly sessionModelSelection: ModelSelection;
  readonly initialTopic: string;
  readonly onClose: () => void;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const options = modelOptions(providers ?? []);
  const startCowork = useAtomCommand(serverEnvironment.startCowork, {
    label: "start cowork",
    failureTitle: "Couldn't launch cowork",
  });
  const [mode, setMode] = useState<CoworkMode>("brainstorm");
  const [rounds, setRounds] = useState("2");
  const [topic, setTopic] = useState(initialTopic);
  const [busy, setBusy] = useState(false);
  const [peers, setPeers] = useState<ReadonlyArray<CoworkPeerDraft>>(() =>
    addCoworkPeer(
      addCoworkPeer([], sessionModelSelection, options),
      sessionModelSelection,
      options,
    ),
  );

  const problem = !canOperate
    ? "This connection cannot start cowork."
    : validateCoworkSetup({ message: topic, rounds: Number(rounds), agents: peers });
  const roleFor = (index: number) => (mode === "brainstorm" && index === 1 ? "Skeptic" : null);

  const choosePeerModel = (key: number, optionKey: string) => {
    // The session's own model keeps its options (effort, thinking); others use defaults.
    const selection =
      optionKey === modelOptionKey(sessionModelSelection)
        ? sessionModelSelection
        : options.find((option) => option.key === optionKey)?.modelSelection;
    if (selection === undefined) return;
    setPeers(
      peers.map((peer) =>
        peer.key === key
          ? {
              ...peer,
              modelSelection: selection,
              label: coworkPeerLabel(
                selection,
                options,
                peers.filter((other) => other.key !== key).map((other) => other.label),
              ),
            }
          : peer,
      ),
    );
  };

  const submit = async () => {
    if (problem !== null || busy) return;
    setBusy(true);
    await startCowork({
      environmentId,
      input: {
        sessionThreadId,
        mode,
        participants: peers.map((peer, index) => {
          const role = roleFor(index);
          return {
            label: peer.label,
            ...(role === null ? {} : { role }),
            modelSelection: peer.modelSelection,
          };
        }),
        maxRounds: Number(rounds),
        message: topic.trim(),
      },
    });
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center gap-2">
        <UsersIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <ToggleGroup
          aria-label="Cowork mode"
          value={[mode]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "brainstorm" || value === "code") setMode(value);
          }}
        >
          <Toggle value="brainstorm">{MODE_LABELS.brainstorm}</Toggle>
          <Toggle value="code">{MODE_LABELS.code}</Toggle>
        </ToggleGroup>
        <div className="flex-1" />
        <Button size="icon-xs" variant="ghost-muted" aria-label="Close cowork" onClick={onClose}>
          <XIcon />
        </Button>
      </div>

      {initialTopic.trim() === "" ? (
        <Textarea
          size="sm"
          rows={2}
          aria-label="Cowork topic"
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
          placeholder={
            mode === "code" ? "What should the peers build?" : "What should the peers decide?"
          }
        />
      ) : (
        <p className="line-clamp-2 text-foreground">{topic}</p>
      )}

      <div className="flex flex-wrap items-center gap-1">
        {peers.map((peer, index) => (
          <div
            key={peer.key}
            className="flex items-center rounded-md border border-border bg-muted/40"
          >
            <Select
              value={modelOptionKey(peer.modelSelection)}
              onValueChange={(value) => {
                if (typeof value === "string") choosePeerModel(peer.key, value);
              }}
            >
              <SelectTrigger variant="ghost" size="xs" aria-label={`${peer.label} model`}>
                <SelectValue>
                  <span className="font-medium">{peer.label}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {peer.modelSelection.model}
                    {roleFor(index) === null ? "" : ` · ${roleFor(index)}`}
                  </span>
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
            {peers.length > 2 ? (
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label={`Remove ${peer.label}`}
                onClick={() => setPeers(peers.filter((other) => other.key !== peer.key))}
              >
                <XIcon />
              </Button>
            ) : null}
          </div>
        ))}
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => setPeers(addCoworkPeer(peers, sessionModelSelection, options))}
        >
          <PlusIcon />
          Add peer
        </Button>
        <div className="flex-1" />
        <Select
          value={rounds}
          onValueChange={(value) => {
            if (typeof value === "string") setRounds(value);
          }}
        >
          <SelectTrigger variant="ghost" size="xs" aria-label="Rounds">
            <SelectValue>{`${rounds} ${rounds === "1" ? "round" : "rounds"}`}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {ROUND_CHOICES.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {choice}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button size="xs" disabled={problem !== null || busy} onClick={() => void submit()}>
          Launch
        </Button>
      </div>
      {problem === null || topic.trim() === "" ? null : (
        <p className="text-muted-foreground">{problem}</p>
      )}
    </div>
  );
}

function PeerStatusDot({ status }: { status: CoworkSession["participants"][number]["status"] }) {
  const tone =
    status === "thinking"
      ? "bg-info"
      : status === "error"
        ? "bg-destructive"
        : status === "done"
          ? "bg-success"
          : "bg-muted-foreground/40";
  return <span className={`size-1.5 shrink-0 rounded-full ${tone}`} aria-label={status} />;
}

function CoworkLive({
  environmentId,
  session,
  collapsed,
  onCollapsedChange,
  onSendToSession,
  onInsertInComposer,
}: {
  readonly environmentId: EnvironmentId;
  readonly session: CoworkSession;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  readonly onSendToSession: (text: string) => Promise<void>;
  readonly onInsertInComposer: (text: string) => void;
}) {
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
    failureTitle: "Couldn't clear cowork",
  });
  const [draft, setDraft] = useState("");
  const [showTranscript, setShowTranscript] = useState(false);
  const [sendingDecision, setSendingDecision] = useState(false);

  const decision = session.phase === "decided" ? coworkDecisionSummary(session) : null;
  const decisionText =
    decision === null
      ? null
      : `${session.mode === "code" ? "Cowork result" : "Cowork decision"}:\n\n${decision}`;
  const activeSpeaker =
    session.speakerIndex === null ? null : session.participants[session.speakerIndex];
  const latestSummary = (label: string) => {
    const latest = session.transcript.findLast((entry) => entry.speaker === label);
    return latest === undefined ? null : coworkTurnSummary(latest);
  };

  const submitFollowUp = () => {
    const message = draft.trim();
    if (message === "" || !canOperate) return;
    setDraft("");
    void send({
      environmentId,
      input: { sessionThreadId: session.sessionThreadId, message },
    }).then((result) => {
      if (result._tag !== "Success") setDraft((current) => (current === "" ? message : current));
    });
  };

  const sendDecision = async () => {
    if (decisionText === null || sendingDecision) return;
    setSendingDecision(true);
    try {
      await onSendToSession(decisionText);
      toastManager.add({ type: "success", title: "Sent to session" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't send to session",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setSendingDecision(false);
    }
  };

  const clear = async () => {
    const message = "Clear this cowork?\nIts hidden peer threads are deleted too.";
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    await remove({ environmentId, input: { sessionThreadId: session.sessionThreadId } });
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <UsersIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{MODE_LABELS[session.mode]}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{session.topic}</span>
        <Badge
          size="sm"
          variant={
            session.phase === "decided"
              ? "success"
              : session.phase === "paused"
                ? "warning"
                : "info"
          }
        >
          {coworkPhaseLabel(session)}
        </Badge>
        {session.phase === "decided" ? null : (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            disabled={!canOperate}
            aria-label={session.phase === "paused" ? "Resume cowork" : "Pause cowork"}
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
          </Button>
        )}
        <Button
          size="icon-xs"
          variant="ghost-destructive"
          disabled={!canOperate}
          aria-label="Stop and clear cowork"
          onClick={() => void clear()}
        >
          <Trash2Icon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={collapsed ? "Expand cowork" : "Collapse cowork"}
          aria-expanded={!collapsed}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </Button>
      </div>

      {collapsed ? null : (
        <div className="flex flex-col gap-2 border-t border-border px-2 py-2">
          <ul className="flex flex-col gap-1">
            {session.participants.map((peer) => {
              const summary = latestSummary(peer.label);
              return (
                <li key={peer.threadId} className="flex min-w-0 items-center gap-1.5">
                  <PeerStatusDot status={peer.status} />
                  <Link
                    to="/$environmentId/$threadId"
                    params={buildThreadRouteParams(scopeThreadRef(environmentId, peer.threadId))}
                    className="shrink-0 font-medium hover:underline"
                  >
                    {peer.label}
                  </Link>
                  <span className="shrink-0 text-muted-foreground">
                    {peer.modelSelection.model}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {summary === null ? "" : summary}
                  </span>
                </li>
              );
            })}
          </ul>

          <p className="text-muted-foreground" role="status">
            {session.note ??
              (session.phase === "thinking"
                ? "Peers are thinking independently…"
                : session.phase === "deliberating" && activeSpeaker
                  ? `${activeSpeaker.label} is ${session.mode === "code" ? "working" : "replying"}…`
                  : session.phase === "decided"
                    ? "Finished."
                    : "Paused.")}
          </p>

          {decisionText === null ? null : (
            <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 p-2">
              <p className="line-clamp-4 whitespace-pre-wrap text-foreground">{decision}</p>
              <div className="flex flex-wrap gap-1">
                <Button
                  size="xs"
                  disabled={sendingDecision || !canOperate}
                  onClick={() => void sendDecision()}
                >
                  <SendIcon />
                  Send to session
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onInsertInComposer(decisionText)}
                >
                  Insert in composer
                </Button>
              </div>
            </div>
          )}

          <div>
            <Button
              size="xs"
              variant="ghost-muted"
              aria-expanded={showTranscript}
              onClick={() => setShowTranscript(!showTranscript)}
            >
              {showTranscript ? <ChevronUpIcon /> : <ChevronDownIcon />}
              Transcript ({session.transcript.length})
            </Button>
          </div>
          {showTranscript ? (
            <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
              {session.transcript.map((message) => (
                <div key={message.id} className="flex flex-col gap-0.5">
                  <span className="font-medium">
                    {message.speaker}
                    {message.kind === "user" ? null : (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        · round {message.round}
                      </span>
                    )}
                  </span>
                  <ChatMarkdown cwd={undefined} text={message.text} />
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <Input
                size="sm"
                aria-label="Follow up with the peers"
                value={draft}
                disabled={!canOperate}
                placeholder="Follow up, or @mention a peer…"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    submitFollowUp();
                  }
                }}
              />
            </div>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Send follow-up"
              disabled={!canOperate || draft.trim() === ""}
              onClick={submitFollowUp}
            >
              <SendIcon />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Cowork docked above the composer: setup until launched, then the live session. */
export default function CoworkCard({
  environmentId,
  threadId,
  session,
  sessionModelSelection,
  initialTopic,
  collapsed,
  onCollapsedChange,
  onClose,
  onSendToSession,
  onInsertInComposer,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly session: CoworkSession | null;
  readonly sessionModelSelection: ModelSelection;
  readonly initialTopic: string;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  readonly onClose: () => void;
  readonly onSendToSession: (text: string) => Promise<void>;
  readonly onInsertInComposer: (text: string) => void;
}) {
  return (
    <section
      aria-label="Cowork"
      data-cowork-card
      className="mb-2 rounded-lg border border-border bg-background text-xs"
    >
      {session === null ? (
        <CoworkSetup
          key={`${threadId}:${initialTopic}`}
          environmentId={environmentId}
          sessionThreadId={threadId}
          sessionModelSelection={sessionModelSelection}
          initialTopic={initialTopic}
          onClose={onClose}
        />
      ) : (
        <CoworkLive
          environmentId={environmentId}
          session={session}
          collapsed={collapsed}
          onCollapsedChange={onCollapsedChange}
          onSendToSession={onSendToSession}
          onInsertInComposer={onInsertInComposer}
        />
      )}
    </section>
  );
}
