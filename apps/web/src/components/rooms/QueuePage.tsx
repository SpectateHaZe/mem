import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, QueueGoal } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { PauseIcon, PlayIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { modelOptions } from "./roomLogic";

const STATUS_LABEL: Record<QueueGoal["status"], string> = {
  pending: "Waiting",
  running: "Working",
  done: "Done",
  failed: "Failed",
};

function ConnectedQueue({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(serverEnvironment.queueLive({ environmentId, input: {} }));
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const options = modelOptions(providers ?? []);
  const add = useAtomCommand(serverEnvironment.addQueueGoal, { label: "add goal" });
  const setPaused = useAtomCommand(serverEnvironment.setQueuePaused, { label: "pause queue" });
  const remove = useAtomCommand(serverEnvironment.removeQueueGoal, { label: "remove goal" });
  const [text, setText] = useState("");
  const [chosenProject, setProject] = useState<string | null>(null);
  const [chosenModel, setModel] = useState<string | null>(null);
  const projectId = chosenProject ?? projects[0]?.id ?? "";
  const optionKey = chosenModel ?? options[0]?.key ?? "";
  const option = options.find((candidate) => candidate.key === optionKey);
  const goals = query.data?.goals ?? [];
  const paused = query.data?.paused ?? false;
  const canAdd = text.trim() !== "" && projectId !== "" && option !== undefined;

  const submit = () => {
    if (option === undefined || !canAdd) return;
    setText("");
    void add({
      environmentId,
      input: {
        projectId: projectId as ProjectId,
        text: text.trim(),
        modelSelection: option.modelSelection,
      },
    });
  };

  return (
    <div className="scrollbar-gutter-both flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
        <div className="flex items-center gap-2">
          <h2 className="me-auto text-lg font-medium">Queue</h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void setPaused({ environmentId, input: { paused: !paused } })}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {query.data?.note ??
            "Agents work these goals one at a time, retry failures, and stop when the list is empty or the daily cap is reached."}
        </p>
        <div className="grid gap-1.5">
          <Label htmlFor="queue-goal">New goal</Label>
          <Textarea
            id="queue-goal"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="What should get done?"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="min-w-48 flex-1">
            <Select value={projectId} onValueChange={(value) => setProject(value ?? "")}>
              <SelectTrigger aria-label="Project">
                <SelectValue>
                  {projects.find((project) => project.id === projectId)?.title ??
                    "Choose a project"}
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
          <div className="min-w-48 flex-1">
            <Select value={optionKey} onValueChange={(value) => setModel(value ?? "")}>
              <SelectTrigger aria-label="Model">
                <SelectValue>{option?.description ?? "Choose a model"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {options.map((candidate) => (
                  <SelectItem key={candidate.key} value={candidate.key}>
                    {candidate.description}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <Button disabled={!canAdd} onClick={submit}>
            Add to queue
          </Button>
        </div>
        <ul className="flex flex-col gap-2">
          {goals.map((goal) => (
            <li key={goal.id} className="flex items-start gap-3 rounded-md border p-3">
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap text-sm">{goal.text}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {STATUS_LABEL[goal.status]}
                  {goal.note ? ` · ${goal.note}` : ""}
                  {goal.threadId ? (
                    <>
                      {" · "}
                      <Link
                        to="/$environmentId/$threadId"
                        params={{ environmentId, threadId: goal.threadId }}
                        className="underline"
                      >
                        Open thread
                      </Link>
                    </>
                  ) : null}
                </p>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Remove goal"
                onClick={() => void remove({ environmentId, input: { goalId: goal.id } })}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function QueuePage() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) {
    return <p className="p-6 text-sm text-muted-foreground">Connecting…</p>;
  }
  return <ConnectedQueue environmentId={environmentId} />;
}
