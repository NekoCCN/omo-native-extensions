# OmO Native Extensions

A community collection of extensions for [OmO Native](https://omo.dev/), tested with OmO Native **5.1.81** and Senpi **2026.11.19-5**. This is not an official OmO distribution. The package does not contain a personal agent configuration, providers, API credentials, or third-party plugins.

## Installation

Install from GitHub in OmO Native:

```sh
omo install git:github.com/NekoCCN/omo-native-extensions
```

Restart OmO or run `/reload` in an idle session. If you already have a manual copy of an extension in your agent directory, do not load both copies. To select only certain extensions, use an OmO package entry with an `extensions` list in `settings.json`, for example:

```json
{
  "packages": [
    {
      "source": "git:github.com/NekoCCN/omo-native-extensions",
      "extensions": ["extensions/agent-detail-style/index.js"]
    }
  ]
}
```

## Extensions

| Extension | What it does | Requirements and limits |
| --- | --- | --- |
| `agent-detail-style` | Restyles the popup opened from an existing **AGENTS** row. Tool groups and long replies can be folded; click a row or use `Ctrl+O`. The outer frame stays fixed while scrolling. | Native clickable side panel in the fullscreen TUI. Uses the native transcript snapshot, not a live tool-output stream. Unknown popup shapes retain native rendering. |
| `auto-compact` | `/auto-compact` shows model context usage and lets you preview, save, or reset a per-model early-compaction boundary. | TUI. Writes a reserve override to `settings.json` on confirmation; does not run compaction or change its adaptive policy. |
| `herdr-status` | Uses `sakura-nocturne` for a session running inside Herdr without persisting the theme globally. | Herdr and an already-installed theme of that name. The theme itself is not bundled. |
| `planning-guide` | Reminds the main session to size its plan, prefer `mass-ulw` where appropriate, and stop once it has evidence. | Uses existing OmO workflows. It does not enable formal Ultrawork or inject the reminder into child sessions. |
| `sidebar-density` | Makes the native TUI sidebar denser, including tool summaries and todo presentation. | Native sidebar and supported viewport layout. It does not enable the sidebar on its own. |
| `subagent-model` | `/subagent-model` exposes model, thinking, and description editing for native roles and categories. | TUI, an existing OmO configuration, and `omo doctor --models --json`. No preset provider keys or model routing are shipped. |

The TUI adapters are local extensions, not modifications to the OmO installer or runtime. They target the native surface described above; other hosts and future OmO versions may differ.

## Development

```sh
bun install
bun test ./extensions
```
