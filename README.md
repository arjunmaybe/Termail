# Termail

A modern, keyboard-driven terminal email client built with TypeScript, designed with a clean and extensible architecture.

## Features (Phase 1)

- **TUI Interface** - Built with `@opentui/core` using its class-based terminal UI API
- **Reactive State** - Fine-grained reactivity with `@preact/signals`
- **SQLite Storage** - Local database with FTS5 full-text search (using Bun's built-in `bun:sqlite`)
- **Configuration** - JSON-based config with Zod validation
- **TypeScript** - Strict type checking throughout
- **Testing** - Bun test runner for unit and integration tests
- **Linting/Formatting** - Biome for code quality

## Planned Features (Phase 2+)

- IMAP synchronization (imapflow)
- SMTP sending (nodemailer)
- Email parsing (mailparser)
- Email composition with external editor
- Search and filtering
- Multiple account support
- AI-assisted features (OpenRouter integration)

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.1+

### Installation

```bash
# Clone and install
git clone <repo-url>
cd termail
bun install

# Development
bun run dev

# Build
bun run build

# Run tests
bun run test

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
│   │   └── utils/              # Utilities (logger, errors)
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
  "accounts": []
}
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `q` / `Q` | Quit |
| `←` / `→` | Switch folders |
| `↑` / `↓` | Navigate emails |
| `Enter` | Open email |
| `Esc` | Back to list |
| `r` | Sync (Phase 2) |

## License

MIT
