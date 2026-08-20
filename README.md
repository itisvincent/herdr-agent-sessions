# herdr-agent-sessions

A Herdr plugin that lists on-disk agent sessions (Claude, Codex, Pi, OMP, Gemini,
Cursor, Grok, Devin, Hermes, Rovo, Droid, Kimi, Copilot, OpenClaw, Prime Agent)
and resumes the one you pick in a new pane — a searchable session panel for Herdr.

## What it does

- **Scans each agent's on-disk session store** and lists sessions by recency.
- **Renders an interactive TUI list** in a Herdr split pane.
- **On Enter**, splits the main pane to the right and resumes the agent there:
  - Primary: `herdr agent start <name> --kind <kind> --pane <new> -- <resume args>`
    (clean argv, Herdr-tracked, no shell-quoting pain).
  - Fallback: `herdr pane run <new> <shell command>` for agents Herdr doesn't
    know a `--kind` for (Prime Agent, Rovo, OpenClaw).

## Install (any PC)

Published GitHub install:

```bat
herdr plugin install itisvincent/herdr-agent-sessions --yes
```

For local development, copy this folder anywhere, then:

```bash
herdr plugin link C:\path\to\herdr-agent-sessions
herdr plugin list
```

Also add this to `%APPDATA%\herdr\config.toml` (once per machine):

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "example.agent-sessions.open"
description = "open agent sessions panel"
```

Then `herdr server reload-config`. Open with `Ctrl+B` then `a`.

Requires Node.js on PATH (`node -v`).

## Windows pane launcher (required for publish)

Do **not** ship a Windows pane command like `["node", "panel.js"]` or
`["node", "boot.js", "panel.js"]`.

On Windows, Herdr starts plugin **panes** with cwd / `HERDR_PLUGIN_ROOT` as a
Win32 verbatim path (`\\?\D:\...`). Node then realpath's the relative entry
script, mis-parses that prefix, and exits immediately:

```
Error: EISDIR: illegal operation on a directory, lstat 'D:'
```

The pane flashes open and vanishes (~100ms, exit code 1). Hardcoding
`D:/workspace/.../panel.js` works on one PC and is not publishable.
`%HERDR_PLUGIN_ROOT%` is not expanded (Herdr argv is not a shell). A helper
like `boot.js` never runs, because Node dies before executing it.

This plugin's Windows pane uses `run.ps1`, which strips `\\?\` and execs
`node` with an **absolute** path to the script. Unix panes use
`["node", "panel.js"]`. Pane ids must be unique even across platforms, so
Windows is `panel-windows` and `open.js` selects it.

Herdr **actions** use a different launcher and can keep `["node", "open.js"]`.

Open the panel with the keybinding (`prefix+sa`) or:

```bash
herdr plugin action invoke example.agent-sessions.open
```

## Keys

| Key | Action |
| --- | --- |
| `↑` / `↓` or `k` / `j` | move |
| `g` / `G` | top / bottom |
| `enter` | resume selected session in a new right pane |
| `/` + type | filter (backspace edits, Esc clears) |
| `r` | re-scan |
| `q` or `Esc` | quit |

## Session discovery

The plugin reads each agent's normal local session directory. You can override
supported roots with the environment variables listed below; no Herdr-specific
session service is required. Session IDs and working directories are extracted
best-effort from filenames, parent directories, or a small head-read of the
transcript. Codex worker and subagent transcripts are filtered out.

## Resume forms (per agent)

| Agent | Resume command | arg |
| --- | --- | --- |
| codex | `codex resume <id>` | id |
| pi | `pi --session <path>` | transcript path |
| opencode, kimi | `<cmd> --session <id>` | id |
| copilot | `copilot --resume=<id>` | id |
| claude, cursor, gemini, grok, hermes, devin, droid, openclaw, omp, prime-agent | `<cmd> --resume <arg>` | id (omp/prime-agent: file path) |
| antigravity | `agy --conversation <id>` | id |
| rovo | `acli rovodev run --restore <id>` | id |

`agent start --kind` is used for: claude, codex, pi, omp, gemini, cursor, grok,
devin, droid, kimi, hermes, opencode, copilot, antigravity. The rest fall back to
`pane run` with platform-aware shell quoting.

## Known limitations / follow-ups

- **opencode** (SQLite 1.17.x DB + legacy files) is discovered through its
  standard data root; custom `XDG_DATA_HOME` values must be inherited by the
  Herdr plugin process. **antigravity** (brain dirs) is not yet discovered.
- **No title/preview/tokens** — rows show agent, recency, and cwd-or-id.
- **No WSL fan-out**: only local `$HOME` roots (+ env overrides like
  `CODEX_HOME`,
  `PI_CODING_AGENT_DIR`, `COPILOT_HOME`, `DEVIN_HOME`, `OPENCLAW_STATE_DIR`).
- **No parse cache**: every refresh re-scans and re-reads session heads.
- **Codex `CODEX_HOME`** is propagated to the new pane via `pane split --env`
  when sessions live under a non-default home.
- Resume opens the agent to the **right of the main pane** (the panel's left
  neighbor). If the panel is the only pane, it splits itself.

## Files

- `herdr-plugin.toml` — manifest (pane and action entrypoints).
- `agents.js` — per-agent source roots, walk predicates, id/cwd extraction,
  resume argv + shell-command builders.
- `panel.js` — scanner, interactive TUI, and Herdr resume glue.
