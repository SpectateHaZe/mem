# Mem

Mem is a desktop app for running coding agents, built as a fork of [T3 Code](https://github.com/pingdotgg/t3code) (MIT). It keeps T3 Code's interface and adds:

- **Group chats.** Put several agents from different providers in one conversation, or let one lead agent hand jobs to helpers.
- **A queue.** Line up goals and leave. Mem retries failures, survives restarts, and stops when the queue is empty or the spending cap is hit.
- **A spending cap.** See what you've used and stop work at a daily limit ($20 by default, editable in Settings).
- **Computer control.** Agents in full-access threads can see the screen and use the mouse and keyboard on Windows. It defaults to full control; Settings → Threads has View only and Off.
- **More models.** DeepSeek and OpenCode's free models, alongside Codex, Claude, Cursor, Grok, Antigravity, Kiro and others.
- **Obscura.** An optional headless browser for reading web pages. It's off by default and downloads about 41 MB the first time an agent uses it.
- **Discord status.** Shows what Mem is doing on your profile, without project names. Paste your Discord Application ID in Settings → Threads.

> [!WARNING]
> With computer control on, an agent in a full-access thread can do anything you can do at your desk. Use View only or Off if that isn't what you want, and don't leave sensitive apps open during unattended runs.

## Install

Download the Windows installer from [Releases](https://github.com/SpectateHaZe/mem/releases). Windows may show a SmartScreen warning because the app isn't code-signed. Installed copies update themselves from new releases.

Mem stores its data in `~/.mem`, so it runs beside an installed T3 Code without touching it.

## Run from source

Mem uses Vite+, so install the `vp` command first.

```bash
vp i
```

```bash
vp run dev
```

## License

MIT, same as T3 Code. See [LICENSE](./LICENSE). Obscura is a separate Apache-2.0 project by its own authors.
