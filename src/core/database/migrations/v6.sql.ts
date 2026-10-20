/**
 * v6 migration — record the IMAP UIDVALIDITY generation per folder.
 *
 * A mailbox's UIDVALIDITY identifies its UID generation. If it changes,
 * UIDs may be reused, so a checkpoint or cached UID-derived row from the
 * previous generation must not be trusted. v6 adds the bookkeeping needed
 * to detect that change.
 *
 * Additive only:
 *   - `uid_validity TEXT`: the exact decimal representation of the observed
 *     UIDVALIDITY, or NULL when the server did not provide a usable value.
 *   - `uid_validity_observed INTEGER NOT NULL DEFAULT 0`: 1 once a
 *     successful sync has attempted to observe the generation, 0 for legacy
 *     rows whose generation was never recorded. This distinguishes a legacy
 *     (unverified) checkpoint from a sync that successfully observed an
 *     unavailable (NULL) UIDVALIDITY.
 *
 * It does NOT rebuild `emails` and does NOT alter any existing email row.
 * Pre-existing `folder_sync_state` rows migrate with
 * `uid_validity = NULL` and `uid_validity_observed = 0`.
 *
 * Forward-only like v3/v4/v5: SQLite cannot drop a column on a table whose
 * triggers live elsewhere, and reverting would discard generation info.
 */

export const MIGRATION_V6_UP_SQL = `
-- Store the exact decimal UIDVALIDITY; NULL when unavailable.
ALTER TABLE folder_sync_state ADD COLUMN uid_validity TEXT;

-- 0 = never observed (legacy), 1 = a successful sync recorded the
-- observation (the value itself may still be NULL when unavailable).
ALTER TABLE folder_sync_state ADD COLUMN uid_validity_observed INTEGER NOT NULL DEFAULT 0;
`;
