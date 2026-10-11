# Termail website

Public product site for Termail. Astro with server-rendered output on the
Node standalone adapter. The CLI application is untouched; everything for the
site lives under `website/`.

## Setup

Requires Bun v1.4.1 (same pin as the repository root).

```bash
cd website
bun install
```

This creates `website/bun.lock` (isolated from the root CLI lockfile).

## Development

```bash
cd website
bun run dev
```

Serves the site with hot reload (default `http://localhost:4321`).

## Production build

```bash
cd website
bun run build
```

Output goes to `website/dist/` (server entry at
`website/dist/server/entry.mjs`).

## Preview and production serving

```bash
cd website
bun run preview   # astro preview on 127.0.0.1:4321
bun run start     # run the built standalone Node server: bun ./dist/server/entry.mjs
```

## Canonical origin (`SITE_URL`)

The deployed page emits a self-referencing canonical URL and matching
Open Graph URL **only** when a valid `SITE_URL` is configured. No production
domain is hardcoded.

```bash
cd website
SITE_URL=https://example.com bun run build
bun run start
```

PowerShell (same session — `SITE_URL` is read when the build runs):

```powershell
cd website
$env:SITE_URL = "https://example.com"
bun run build
bun run start
Remove-Item Env:\SITE_URL
```

Rules:

- `SITE_URL` must be an absolute `http(s)` origin (e.g. `https://example.com`).
- When unset or invalid, no `<link rel="canonical">` and no absolute
  `og:url` / `og:image` are emitted.
- `SITE_URL` affects metadata only, never routing.

## Type checking

```bash
cd website
bun run check
```

## Assets

- `website/public/termail.png` is a byte-identical copy of the synthetic
  demo screenshot at `docs/termail.png`. It shows fictional demo data, never
  private mail.
