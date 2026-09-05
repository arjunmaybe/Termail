/**
 * Database module barrel.
 *
 * Consumers should import from here rather than from the individual
 * files so we can refactor internals without breaking downstream code.
 */

export { Database, getDatabase, resetDatabase } from './Database.js';
export {
  getMigrations,
  getCurrentVersion,
  runMigrations,
  rollbackMigration,
} from './migrations.js';
export type { Migration } from './migrations.js';
export {
  SCHEMA_VERSION,
  CREATE_TABLES_SQL,
  CREATE_TABLES_V1_SQL,
  DROP_TABLES_SQL,
} from './schema.js';
export { MIGRATION_V2_UP_SQL } from './migrations/v2.sql.js';
export { MIGRATION_V3_UP_SQL } from './migrations/v3.sql.js';
export {
  MessageRepository,
  buildImapSyncLimits,
  persistSyncResult,
  deriveEmailId,
  deriveFolderId,
  serializeAddresses,
  serializeAttachments,
  serializeFlags,
  parseAddresses,
  parseAttachments,
  parseFlags,
  toEpochSeconds,
} from './MessageRepository.js';
export type {
  SafeAccountInput,
  SyncStatus,
  FolderSyncState,
  PersistedEmail,
  PersistedFolder,
  UpsertMessagesResult,
  PersistSyncResultOptions,
  SyncStatusOptions,
} from './MessageRepository.js';
export {
  SearchRepository,
  buildMatchQuery,
  clampLimit,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
} from './SearchRepository.js';
export type { SearchHit, SearchOptions } from './SearchRepository.js';
