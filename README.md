<p align="center">
  <img src="assets/prod/mem-logo-source.png" alt="Mem logo" width="160" />
</p>

# Mem

Mem is a desktop app for running coding agents, built as a fork of [T3 Code](https://github.com/pingdotgg/t3code) (MIT). It keeps T3 Code's interface and adds:

- **Group chats.** Put several agents from different providers in one conversation, or let one lead agent hand jobs to helpers.
- **Subagent picker.** Choose a model from any provider next to the composer and your next message starts it in the side panel. It can report back to the main agent or stay separate.
- **Low usage mode.** Turn it on for a thread in the details panel and pick a cheaper subagent model. The main agent then plans and delegates instead of doing the work itself.
- **A queue.** Line up goals and leave. Mem retries failures, survives restarts, and stops when the queue is empty or the spending cap is hit.
- **A spending cap.** See what you've used and stop work at a daily limit ($20 by default, editable in Settings).
- **Computer control.** Agents in full-access threads can see the screen and use the mouse and keyboard on Windows. It defaults to full control; Settings → Threads has View only and Off.
- **More models.** DeepSeek and OpenCode's free models, alongside Codex, Claude, Cursor, Grok, Antigravity, Kiro and others.
- **Obscura.** An optional headless browser for reading web pages. It's off by default and downloads about 41 MB the first time an agent uses it.
- **Discord status.** Shows how many agents are working on your Discord profile, without project names. It is on by default; clear the Application ID in Settings → Threads to turn it off.

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
