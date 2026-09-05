/**
 * Database migration runner
 */

import type { Database } from 'bun:sqlite';
import { DatabaseError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { MIGRATION_V2_UP_SQL } from './migrations/v2.sql.js';
import { CREATE_TABLES_SQL, SCHEMA_VERSION } from './schema.js';

export interface Migration {
  version: number;
  description: string;
  up: (db: Database) => void;
  down?: (db: Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    description: 'Initial schema with accounts, folders, emails, and FTS5',
    up: (db: Database) => {
      db.exec(CREATE_TABLES_SQL);
    },
    down: (db: Database) => {
      db.exec(`
        DROP TABLE IF EXISTS emails_fts;
        DROP TABLE IF EXISTS emails;
        DROP TABLE IF EXISTS folders;
        DROP TABLE IF EXISTS accounts;
        DROP TABLE IF EXISTS schema_version;
      `);
    },
  },
  {
    version: 2,
    description:
      'Add IMAP synchronization identity (uid) and per-folder sync state',
    up: (db: Database) => {
      db.exec(MIGRATION_V2_UP_SQL);
    },
    down: (db: Database) => {
      // Drop the new indexes and table. We do not attempt to remove
      // the v2 columns from `emails` — SQLite has no `DROP COLUMN`
      // (and even if it did, dropping columns referenced by an
      // existing FTS trigger is unsafe). v2→v1 rollback is therefore a
      // forward-only operation: it discards the new sync state but
      // keeps the new columns in place. A fresh v1 database is the
      // safe way to go back.
      db.exec(`
        DROP INDEX IF EXISTS idx_emails_internal_date;
        DROP INDEX IF EXISTS uq_emails_account_folder_uid;
        DROP TABLE IF EXISTS folder_sync_state;
      `);
    },
  },
];

export function getMigrations(): Migration[] {
  return migrations;
}

export function getCurrentVersion(db: Database): number {
  try {
    const result = db
      .query('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined;
    return result?.version ?? 0;
  } catch {
    return 0;
  }
}

export function setVersion(db: Database, version: number): void {
  db.exec('DELETE FROM schema_version');
  db.exec(`INSERT INTO schema_version (version) VALUES (${version})`);
}

export function runMigrations(db: Database): void {
  const currentVersion = getCurrentVersion(db);
  const pendingMigrations = migrations.filter((m) => m.version > currentVersion);

  if (pendingMigrations.length === 0) {
    logger.debug('No pending migrations');
    return;
  }

  logger.info('Running database migrations', { currentVersion, pending: pendingMigrations.length });

  for (const migration of pendingMigrations) {
    logger.info('Applying migration', {
      version: migration.version,
      description: migration.description,
    });
    try {
      db.transaction(() => {
        migration.up(db);
        setVersion(db, migration.version);
      })();
      logger.info('Migration applied', { version: migration.version });
    } catch (error) {
      logger.error('Migration failed', { version: migration.version, error });
      throw new DatabaseError(`Migration ${migration.version} failed: ${error}`);
    }
  }

  logger.info('All migrations completed', { version: SCHEMA_VERSION });
}

export function rollbackMigration(db: Database, targetVersion: number): void {
  const currentVersion = getCurrentVersion(db);
  if (targetVersion >= currentVersion) {
    throw new DatabaseError('Target version must be less than current version');
  }

  const toRollback = migrations
    .filter((m) => m.version > targetVersion && m.version <= currentVersion)
    .sort((a, b) => b.version - a.version);

  for (const migration of toRollback) {
    if (!migration.down) {
      throw new DatabaseError(`Migration ${migration.version} cannot be rolled back`);
    }
    logger.info('Rolling back migration', { version: migration.version });
    try {
      db.transaction(() => {
        migration.down!(db);
        setVersion(db, migration.version - 1);
      })();
      logger.info('Migration rolled back', { version: migration.version });
    } catch (error) {
      logger.error('Rollback failed', { version: migration.version, error });
      throw new DatabaseError(`Rollback ${migration.version} failed: ${error}`);
    }
  }
}
