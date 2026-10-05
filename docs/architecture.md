# Termail architecture

Bun + TypeScript. OpenTUI renders the TUI, `@preact/signals` holds UI state,
`bun:sqlite` persists mail, imapflow syncs, native `node:net`/`node:tls`
sends, OpenRouter (optional, off by default) assists.

## Pieces

- `src/app/App.ts` — root renderable. Owns controllers, runs sync
  orchestration (`requestSync`), keyboard navigation state transitions.
- `src/core/state/AppState.ts` — signal store (`accounts`, `folders`,
  `emails`, selection, sync/search/compose/AI slices) plus actions.
- `src/app/services/SyncService.ts` — data-layer sync. Takes an account,
  drives `ImapService`, persists via `MessageRepository`, returns a
  `SyncOutcome`. No UI imports.
- `src/app/services/SearchService.ts` + `SearchController.ts` — translate
  parsed queries to `SearchRepository` calls; own the search input buffer.
- `src/app/services/ComposeController.ts` — builds the envelope from
  compose state and the current account, delegates to `SmtpService`.
- `src/app/services/AiController.ts` — selected-email summarization and
  reply drafts. Display text only; drafts route into compose for review.
- `src/core/imap/` — `ImapService` (connect, folder listing, batched
  fetch, secret redaction), `folders` (classify/dedupe/order),
  `messages` (fetch planning, mailparser normalization, UID/Message-ID
  dedupe).
- `src/core/smtp/` — `SmtpService` (config/credential resolution, outcome
  mapping), `transport` (implicit-TLS / STARTTLS, AUTH PLAIN/LOGIN),
  `message` (envelope builder, BCC stays envelope-only).
- `src/core/database/` — `Database` (bun:sqlite, WAL, migrations),
  `MessageRepository` (upserts, sync state, folder/email reads),
  `SearchRepository` (FTS5 + structured search). Migrations in
  `migrations.ts` + `migrations/v*.sql.ts`, currently at version 4.
- `src/core/ai/` — `AiService` plus `OpenRouterTransport` (fetch with
  timeout covering the full response body, injectable for tests).
- `src/core/config/` — JSON config at `~/.config/termail/config.json`
  with Zod validation. Secrets never live here; they come from
  `TERMAIL_<ACCOUNT_ID>_PASSWORD` / `TERMAIL_<ACCOUNT_ID>_OAUTH_TOKEN`.

## Sync invariant

Identity is `(account, folder, UID)`. `message_id` is nullable storage for
missing Message-IDs and never part of the sync identity.

Successful sync:

- fetch new UIDs (`sinceUid` exclusive, from the stored checkpoint)
- persist messages and folders in one transaction
- advance the checkpoint (`highest_uid` is `MAX`-monotonic, never regresses)

Failed sync:

- record the error in `folder_sync_state` without touching `highest_uid`
- never surface a success state
- close the IMAP connection in a `finally` block
- retry later from the preserved checkpoint

One manual sync runs at a time (global single-flight); a completion that
arrives after a folder/account switch never overwrites the new selection.

## Fresh-account bootstrap

```
no persisted folders
→ connect to IMAP
→ discover folders
→ persist folders
→ select INBOX when available
→ sync that folder's messages
```

If discovery succeeds but the message sync fails, the folders stay
persisted and visible while the outcome remains an explicit
authentication/network error.
