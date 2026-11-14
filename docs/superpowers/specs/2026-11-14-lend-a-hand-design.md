# Lend a Hand

One person (the **host**) lets one chat in another person's Mem (the **helper**) work on their PC,
for fixing a problem together. Not for using several of your own devices: that is linked
environments.

## Flow

1. Host clicks **Ask for a hand** (Settings → Connections). Their Mem starts a private listener,
   opens a Cloudflare quick tunnel to it, and shows a **hand code**. Unused codes expire after
   15 minutes; a session ends after 2 hours at most.
2. Host sends the code to the helper (Discord, etc.).
3. Helper opens the chat to work in and pastes the code (**Lend a hand** in the chat header).
4. That one chat's agent can now use `hand_run`, `hand_screenshot` and `hand_act` on the host's PC.
   No other chat or agent can. The agent acts freely: no approval per command.
5. On the host: the screen glows while the agent works, a pill shows who is helping, every action
   is listed live, and **End**, Esc, or quitting Mem ends access at once.

## Decisions

- **Own channel, not linked environments.** A peer link reaches the host's whole Mem (threads,
  settings). The hand listener is a separate HTTP server on 127.0.0.1 that only knows four routes
  (`hello`, `run`, `screenshot`, `act`). The tunnel points at that listener, never at Mem's server.
- **Code = tunnel URL + 32-byte random secret**, base64url JSON with a `mem-hand-` prefix. The secret
  is a bearer token, compared in constant time, held in memory only.
- **Cloudflare quick tunnel** (`cloudflared tunnel --url`): free, no account, no port forwarding.
  Pinned release, downloaded on first use, checked against a pinned SHA-256. Windows x64 and macOS
  arm64.
- **Helper state is in memory**: a Mem restart forgets the connection; paste the code again.
- **Esc on the host ends the session** (simpler and safer than pausing one action).
- **v1 does not share the chat itself** with the host. They see the action list and talk to the
  helper elsewhere.

## Limits

- Commands run as the host's user in PowerShell (Windows) or `/bin/sh` (macOS), 120 s timeout,
  output capped at 100 KB per stream.
- Desktop control needs the host on Windows or macOS (same code as computer use).
- Traffic is encrypted but passes through Cloudflare.
