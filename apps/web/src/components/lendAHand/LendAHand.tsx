import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, HandHostState, ScopedThreadRef } from "@t3tools/contracts";
import { HandIcon } from "lucide-react";
import { useId, useState } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Lend a Hand: a host lets one chat in a helper's Mem work on this PC. The host side lives in
 * Settings and a pill on every screen; the helper side is a control in the chat header.
 */

const LOG_SHOWN = 30;

const failureMessage = (result: unknown, fallback: string) => {
  const failure = squashAtomCommandFailure(result as never);
  return failure instanceof Error && failure.message.trim() !== "" ? failure.message : fallback;
};

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

function useHandHost(environmentId: EnvironmentId | null) {
  const { data } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.handHostLive({ environmentId, input: {} }),
  );
  const start = useAtomCommand(serverEnvironment.startHandHost, { reportFailure: false });
  const end = useAtomCommand(serverEnvironment.endHandHost, { label: "end Lend a Hand" });
  return { state: data ?? null, start, end };
}

const expiresLabel = (state: HandHostState) =>
  state.expiresAtMs === null
    ? ""
    : `ends ${formatRelativeTimeLabel(new Date(state.expiresAtMs).toISOString())}`;

/** Settings → Connections: ask for a hand, share the code, see what the helper does, end it. */
export function LendAHandSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const { state, start, end } = useHandHost(environmentId);
  const [busy, setBusy] = useState(false);
  if (environmentId === null) return null;
  const status = state?.status ?? "off";

  const begin = async () => {
    setBusy(true);
    const result = await start({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast("Lend a Hand could not start", failureMessage(result, "Try again."));
    }
  };

  return (
    <SettingsSection id="lend-a-hand" title="Lend a hand" icon={<HandIcon />}>
      {status === "off" ? (
        <SettingsRow
          title="Ask someone for a hand"
          description="Get a code to send someone who also has Mem. One chat in their Mem can then run commands, see your screen and use your mouse and keyboard, without asking first. Esc or End stops it at once."
          control={
            <Button size="xs" disabled={busy} onClick={() => void begin()}>
              {busy ? "Starting…" : "Ask for a hand"}
            </Button>
          }
        >
          {state?.error ? <p className="text-muted-foreground text-xs">{state.error}</p> : null}
        </SettingsRow>
      ) : status === "starting" ? (
        <SettingsRow
          title="Opening a private tunnel…"
          description="The first time, Mem downloads Cloudflare's tunnel program."
          role="status"
        />
      ) : (
        <SettingsRow
          title={
            status === "waiting"
              ? "Send this code to the person helping you"
              : `${state?.helperName ?? "Someone"} is helping you`
          }
          description={
            status === "waiting"
              ? `They paste it with Lend a hand in a chat. The code ${expiresLabel(state!)} if unused.`
              : `Their chat can use this PC. The session ${expiresLabel(state!)}.`
          }
          control={
            <Button
              size="xs"
              variant="destructive-outline"
              onClick={() => void end({ environmentId, input: {} })}
            >
              End
            </Button>
          }
        >
          {status === "waiting" && state?.code ? (
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs">
                {state.code}
              </code>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  void writeTextToClipboard(state.code!).then(() =>
                    toastManager.add({ type: "success", title: "Hand code copied" }),
                  );
                }}
              >
                Copy
              </Button>
            </div>
          ) : null}
        </SettingsRow>
      )}
      {state !== null && state.log.length > 0 ? (
        <SettingsRow title="What the helper did" description="Newest first.">
          <ul className="max-h-60 space-y-1 overflow-auto">
            {state.log
              .toReversed()
              .slice(0, LOG_SHOWN)
              .map((entry) => (
                <li key={`${entry.atMs}:${entry.summary}`} className="flex gap-2 text-xs">
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {new Date(entry.atMs).toLocaleTimeString()}
                  </span>
                  <span className="min-w-0 break-words font-mono">{entry.summary}</span>
                </li>
              ))}
          </ul>
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}

/** On every screen while this PC is shared, so the owner always sees it and can end it. */
export function LendAHandHostPill() {
  const environmentId = usePrimaryEnvironmentId();
  const { state, end } = useHandHost(environmentId);
  if (environmentId === null || state === null) return null;
  if (state.status !== "waiting" && state.status !== "connected") return null;
  return (
    <div
      role="status"
      className="fixed top-2 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-primary/30 bg-popover px-3 py-1 text-xs shadow-md"
    >
      <HandIcon aria-hidden className="size-3.5 text-primary" />
      <span>
        {state.status === "connected"
          ? `${state.helperName ?? "Someone"} is helping on this PC`
          : "Waiting for your helper to connect"}
      </span>
      <Button size="xs" variant="ghost" onClick={() => void end({ environmentId, input: {} })}>
        End
      </Button>
    </div>
  );
}

/** The helper's side: connect this chat with a hand code, or show whose PC it is working on. */
export function LendAHandHeaderControl({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = threadRef;
  const { data } = useEnvironmentQuery(
    serverEnvironment.handHelperLive({ environmentId, input: {} }),
  );
  const connect = useAtomCommand(serverEnvironment.connectHand, { reportFailure: false });
  const disconnect = useAtomCommand(serverEnvironment.disconnectHand, {
    label: "disconnect Lend a Hand",
  });
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const session = data?.sessions.find((candidate) => candidate.threadId === threadId) ?? null;

  if (session !== null) {
    return (
      <div className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
        <HandIcon aria-hidden className="size-3.5 text-primary" />
        <span>Helping {session.hostName}</span>
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => void disconnect({ environmentId, input: { threadId } })}
        >
          Disconnect
        </Button>
      </div>
    );
  }

  const submit = async () => {
    if (busy || code.trim() === "") return;
    setBusy(true);
    const result = await connect({ environmentId, input: { threadId, code: code.trim() } });
    setBusy(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: `Connected to ${result.value.hostName}'s PC`,
        description: "This chat's agent can now use hand_run, hand_screenshot and hand_act.",
      });
      setCode("");
      setOpen(false);
    } else if (!isAtomCommandInterrupted(result)) {
      failureToast("Couldn't connect", failureMessage(result, "Check the code and try again."));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button size="xs" variant="ghost-muted" title="Lend a hand" aria-label="Lend a hand">
            <HandIcon className="size-3.5" />
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Lend a hand</DialogTitle>
          <DialogDescription>
            Paste the hand code someone sent you. This chat's agent can then work on their PC. No
            other chat can.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="mem-hand-…"
              disabled={busy}
              autoFocus
              nativeInput
              spellCheck={false}
            />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            Cancel
          </DialogClose>
          <Button form={formId} type="submit" disabled={busy || code.trim() === ""}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
