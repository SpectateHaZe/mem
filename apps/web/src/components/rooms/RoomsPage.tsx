import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ProjectId, Room, RoomId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { PauseIcon, PlayIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  decisionLine,
  modelOptions,
  speakerColor,
  validateNewRoom,
  withoutDecision,
} from "./roomLogic";

const STATUS_TEXT = { idle: "Finished", running: "Discussing", paused: "Paused" } as const;

function NewRoomForm({
  environmentId,
  onCreated,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly onCreated: (roomId: RoomId) => void;
  readonly onCancel: () => void;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const options = modelOptions(providers ?? []);
  const create = useAtomCommand(serverEnvironment.createRoom, { label: "create group chat" });
  const [title, setTitle] = useState("");
  const [chosenProjectId, setProjectId] = useState<string | null>(null);
  const projectId = chosenProjectId ?? projects[0]?.id ?? "";
  const [maxRounds, setMaxRounds] = useState("3");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState([
    { key: 0, optionKey: options[0]?.key ?? "", label: options[0]?.label ?? "", role: "" },
    { key: 1, optionKey: options[1]?.key ?? "", label: options[1]?.label ?? "", role: "Critic" },
  ]);
  const rounds = Number(maxRounds);
  const problem = validateNewRoom({ title, message, rounds, projectId, agents });

  const patchAgent = (key: number, patch: Partial<(typeof agents)[number]>) =>
    setAgents((current) =>
      current.map((agent) => (agent.key === key ? { ...agent, ...patch } : agent)),
    );

  const submit = async () => {
    setBusy(true);
    const participants = agents.flatMap((agent) => {
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
    const result = await create({
      environmentId,
      input: {
        projectId: projectId as ProjectId,
        title: title.trim(),
        participants,
        maxRounds: rounds,
        message: message.trim(),
      },
    });
    setBusy(false);
    if (result._tag === "Success") onCreated(result.value.id);
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <h2 className="text-lg font-medium">New group chat</h2>
      <div className="grid gap-1.5">
        <Label htmlFor="room-title">Title</Label>
        <Input
          id="room-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Sync design"
        />
      </div>
      <div className="grid gap-1.5">
        <Label>Project</Label>
        <Select value={projectId} onValueChange={(value) => setProjectId(value ?? "")}>
          <SelectTrigger aria-label="Project">
            <SelectValue>
              {projects.find((project) => project.id === projectId)?.title ?? "Choose a project"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label>Agents</Label>
        {agents.map((agent) => (
          <div key={agent.key} className="flex flex-wrap items-center gap-2">
            <div className="min-w-48 flex-1">
              <Select
                value={agent.optionKey}
                onValueChange={(value) => {
                  const option = options.find((candidate) => candidate.key === value);
                  if (option !== undefined) {
                    patchAgent(agent.key, { optionKey: option.key, label: option.label });
                  }
                }}
              >
                <SelectTrigger aria-label="Model">
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
            <div className="w-28">
              <Input
                aria-label="Name used for @mentions"
                value={agent.label}
                onChange={(event) => patchAgent(agent.key, { label: event.target.value })}
                placeholder="Name"
              />
            </div>
            <div className="w-32">
              <Input
                aria-label="Role"
                value={agent.role}
                onChange={(event) => patchAgent(agent.key, { role: event.target.value })}
                placeholder="Role (optional)"
              />
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Remove agent"
              disabled={agents.length <= 2}
              onClick={() =>
                setAgents((current) => current.filter((other) => other.key !== agent.key))
              }
            >
              <XIcon />
            </Button>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setAgents((current) => [
                ...current,
                {
                  key: Math.max(...current.map((agent) => agent.key)) + 1,
                  optionKey: options[0]?.key ?? "",
                  label: "",
                  role: "",
                },
              ])
            }
          >
            <PlusIcon /> Add agent
          </Button>
        </div>
      </div>
      <div className="grid w-32 gap-1.5">
        <Label htmlFor="room-rounds">Rounds</Label>
        <Input
          id="room-rounds"
          inputMode="numeric"
          value={maxRounds}
          onChange={(event) => setMaxRounds(event.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="room-message">First message</Label>
        <Textarea
          id="room-message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="What should they discuss?"
        />
      </div>
      {problem === null ? null : <p className="text-xs text-muted-foreground">{problem}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={problem !== null || busy} onClick={() => void submit()}>
          Start discussion
        </Button>
      </div>
    </div>
  );
}

function RoomView({
  environmentId,
  room,
  onDeleted,
}: {
  readonly environmentId: EnvironmentId;
  readonly room: Room;
  readonly onDeleted: () => void;
}) {
  const send = useAtomCommand(serverEnvironment.sendToRoom, { label: "message group chat" });
  const setPaused = useAtomCommand(serverEnvironment.setRoomPaused, { label: "pause group chat" });
  const remove = useAtomCommand(serverEnvironment.deleteRoom, { label: "delete group chat" });
  const [draft, setDraft] = useState("");
  const speaker = room.speakerIndex === null ? null : room.participants[room.speakerIndex];

  const submit = () => {
    const message = draft.trim();
    if (message === "") return;
    setDraft("");
    void send({ environmentId, input: { roomId: room.id, message } });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <h2 className="me-auto truncate text-sm font-medium">{room.title}</h2>
        {room.participants.map((participant) => (
          <Link
            key={participant.threadId}
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: participant.threadId }}
            className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            title="Open this agent's full thread"
          >
            {participant.label}
            {participant.role ? ` · ${participant.role}` : ""}
          </Link>
        ))}
        {room.status === "idle" ? null : (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void setPaused({
                environmentId,
                input: { roomId: room.id, paused: room.status === "running" },
              })
            }
          >
            {room.status === "running" ? <PauseIcon /> : <PlayIcon />}
            {room.status === "running" ? "Pause" : "Resume"}
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Delete group chat"
          title="Delete group chat (agent threads are kept)"
          onClick={() =>
            void remove({ environmentId, input: { roomId: room.id } }).then((result) => {
              if (result._tag === "Success") onDeleted();
            })
          }
        >
          <Trash2Icon />
        </Button>
      </div>
      <div className="scrollbar-gutter-both flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
          {room.transcript.map((message) => {
            const decision = decisionLine(message.text);
            return (
              <div key={`${message.at}:${message.speaker}`}>
                <div
                  className="text-xs font-semibold"
                  style={{ color: speakerColor(message.speaker) }}
                >
                  {message.speaker}
                </div>
                <p className="whitespace-pre-wrap text-sm">{withoutDecision(message.text)}</p>
                {decision === null ? null : (
                  <div className="mt-2 rounded-md border-s-2 border-success bg-muted/50 px-3 py-2 text-sm">
                    <span className="font-medium">Decision:</span> {decision}
                  </div>
                )}
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground" role="status">
            {room.note ??
              (speaker && room.status === "running"
                ? `${speaker.label} is replying…`
                : STATUS_TEXT[room.status])}
          </p>
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl p-4 pt-0">
        <Textarea
          aria-label="Message the group"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Message the group, or @ one agent…"
        />
      </div>
    </div>
  );
}

export function RoomsPage() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) {
    return <p className="p-6 text-sm text-muted-foreground">Connecting…</p>;
  }
  return <ConnectedRooms environmentId={environmentId} />;
}

function ConnectedRooms({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(serverEnvironment.roomsLive({ environmentId, input: {} }));
  const settings = usePrimarySettings();
  const rooms = query.data?.rooms ?? [];
  const spent = query.data?.spentTodayUsd ?? 0;
  const cap = settings.dailySpendCapUsd;
  const [selectedId, setSelectedId] = useState<RoomId | null>(null);
  const [creating, setCreating] = useState(false);
  const selected = rooms.find((room) => room.id === selectedId) ?? rooms[0] ?? null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside className="flex w-56 shrink-0 flex-col gap-1 border-e p-2">
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          <PlusIcon /> New group chat
        </Button>
        {rooms.map((room) => (
          <Button
            key={room.id}
            size="sm"
            variant={room.id === selected?.id && !creating ? "secondary" : "ghost"}
            className="justify-start"
            onClick={() => {
              setCreating(false);
              setSelectedId(room.id);
            }}
          >
            <span className="truncate">{room.title}</span>
          </Button>
        ))}
        <p className="mt-auto px-2 text-xs text-muted-foreground">
          ~${spent.toFixed(2)} {cap === null ? "today" : `of $${cap.toFixed(2)} today`}
        </p>
      </aside>
      {creating || selected === null ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <NewRoomForm
            environmentId={environmentId}
            onCancel={() => setCreating(false)}
            onCreated={(roomId) => {
              setCreating(false);
              setSelectedId(roomId);
            }}
          />
        </div>
      ) : (
        <RoomView
          key={selected.id}
          environmentId={environmentId}
          room={selected}
          onDeleted={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
