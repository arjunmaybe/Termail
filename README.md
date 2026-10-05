# Termail

A modern, keyboard-driven terminal email client built with TypeScript, designed with a clean and extensible architecture.

## Features (Phases 1–5)

- **TUI Interface** - Built with `@opentui/core` using its class-based terminal UI API
- **Reactive State** - Fine-grained reactivity with `@preact/signals`
- **SQLite Storage** - Local database with FTS5 full-text search (using Bun's built-in `bun:sqlite`)
- **Configuration** - JSON-based config with Zod validation
- **TypeScript** - Strict type checking throughout
- **Testing** - Bun test runner for unit and integration tests (`bun test --parallel=1` deterministic gate / `bun run test`); Vitest runner available for the Node-compatible subset via `bun run test:vitest`
- **Linting/Formatting** - Biome for code quality
- **IMAP synchronization** (imapflow) with SQLite persistence
- **Email parsing** (mailparser)
- **SMTP sending** (native `node:net` / `node:tls`, no external SMTP library)
- **Search and filtering** (FTS5 + structured operators)
- **AI-assisted summarization and reply drafting** (OpenRouter integration)

## Limitations

- Compose is service-level (`ComposeController` + `SmtpService`): sending works
  programmatically and via AI-drafted replies routed into compose for review.
  There is no full-screen compose editor; external-editor composition is planned.
- `bun run build` currently fails to bundle `@opentui/core` platform packages
  in this environment (pre-existing packaging issue, unrelated to app code).
  `bun run dev`, `bun run test:sequential`, and `bun run typecheck` are the
  canonical checks.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.1+

### Installation process for the viewer :

```bash
# Clone and install
git clone <repo-url>
cd termail
bun install

# Development
bun run dev

# Build — currently blocked (see Limitations; command kept for reference)
# bun run build

# Run tests (deterministic Bun gate: sequential workers avoid
# pre-existing TUI renderer / global-state contention)
bun run test:sequential

# Vitest runner for the Node-compatible subset only
# (uses vitest.config.ts + src/test/setup.ts).
# The DB-backed suite requires Bun's `bun:sqlite`, so Vitest under
# Node cannot load it; it does not execute the complete suite.
# Bun remains the canonical runner.
bun run test:vitest

# Type check
bun run typecheck

# Lint
bun run lint

# Format
bun run format
```

## Project Structure

```text
termail/
├── src/
│   ├── main.ts                 # Entry point
│   ├── app/
│   │   ├── App.ts              # Root renderable
│   │   ├── layout/             # Layout components (Sidebar, ContentPane, StatusBar)
│   │   ├── components/         # UI components (EmailListView, FolderTabs, WelcomeView)
│   │   └── theme.ts            # Color themes
│   ├── core/
│   │   ├── config/             # Configuration system (ConfigStore, defaults, Zod schema)
│   │   ├── database/           # SQLite database layer (Database, migrations, schema)
│   │   ├── state/              # Reactive app state
│   │   ├── types/              # Core TypeScript types
│   │   ├── imap/               # IMAP sync (service, folders, messages, credentials)
│   │   ├── smtp/               # SMTP sending (service, transport, message, config)
│   │   ├── search/             # Search query parser
│   │   ├── ai/                 # AI assistance (service, prompts, transport)
│   │   └── utils/              # Utilities (logger, errors)
│   ├── app/services/           # SyncService, SearchService/Controller, Compose/AiController
│   └── test/                   # Test setup
├── tests/                      # Test files
├── package.json
├── tsconfig.json
├── biome.json
└── README.md
```

## Configuration

Configuration is stored at `~/.config/termail/config.json`:

```json
{
  "version": 1,
  "database": {
    "path": "~/.local/share/termail/db.sqlite"
  },
  "ui": {
    "theme": "dark",
    "paneRatio": 0.3,
    "showStatusBar": true,
    "showFolderIcons": true,
    "compactMode": false
  },
  "accounts": [],
  "ai": {
    "enabled": false,
    "provider": "openrouter",
    "model": "meta-llama/llama-3.3-70b-instruct",
    "endpoint": "https://openrouter.ai/api/v1/chat/completions",
    "maxBodyChars": 8000,
    "requestTimeoutMs": 30000
  }
}
```

Credentials are never stored in config. Set per-account secrets in the
environment (`TERMAIL_<ACCOUNT_ID>_PASSWORD` or `TERMAIL_<ACCOUNT_ID>_OAUTH_TOKEN`;
non-alphanumeric id characters become `_`). SMTP requires `smtpHost` on the
account; `smtpPort`/`smtpMode` default to implicit-tls/465.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `j` / Down | Next email |
| `k` / Up | Previous email |
| `h` / Left | Previous folder |
| `l` / Right, `Tab` | Next folder |
| `Enter` | Select first email when none selected |
| `Esc` | Back to list |
| `q` | Quit |
| `/` | Search (`Esc` cancels, `Enter` submits) |
| `r` | Sync current folder |
| `s` | AI summary |
| `d` | AI draft reply (into compose, never auto-sends) |

## License

License not yet specified.
