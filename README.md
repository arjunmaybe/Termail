# Termail

A modern TypeScript terminal email client inspired by the concept of ffail, built from scratch with a clean architecture.

## Features (Phase 1)

- **TUI Interface** - Built with `@opentui/core` (React-like terminal UI)
- **Reactive State** - Fine-grained reactivity with `@preact/signals`
- **SQLite Storage** - Local database with FTS5 full-text search (using Bun's built-in `bun:sqlite`)
- **Configuration** - JSON-based config with Zod validation
- **TypeScript** - Strict type checking throughout
- **Testing** - Vitest for unit and integration tests
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

```
termail/
├── src/
│   ├── main.ts                 # Entry point
│   ├── app/
│   │   ├── App.tsx             # Root component
│   │   ├── layout/             # Layout components
│   │   ├── components/         # UI components
│   │   ├── hooks/              # React hooks
│   │   └── theme.ts            # Color themes
│   ├── core/
│   │   ├── config/             # Configuration system
│   │   ├── database/           # SQLite database layer
│   │   ├── state/              # Reactive app state
│   │   ├── types/              # Core TypeScript types
│   │   └── utils/              # Utilities
│   └── test/                   # Test setup
├── tests/                      # Test files
├── package.json
├── tsconfig.json
├── biome.json
├── vitest.config.ts
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