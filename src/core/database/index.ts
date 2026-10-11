/**
 * Database module barrel.
 *
 * Consumers should import from here rather than from the individual
 * files so we can refactor internals without breaking downstream code.
 */

export { Database, getDatabase, resetDatabase } from './Database.js';
export type {
  FolderSyncState,
  PersistedEmail,
  PersistedFolder,
  PersistSyncResultOptions,
  SafeAccountInput,
  SyncStatus,
  SyncStatusOptions,
  UpsertMessagesResult,
} from './MessageRepository.js';
export {
  buildImapSyncLimits,
  deriveEmailId,
  deriveFolderId,
  MessageRepository,
  parseAddresses,
  parseAttachments,
  parseFlags,
  persistSyncResult,
  serializeAddresses,
  serializeAttachments,
  serializeFlags,
  toEpochSeconds,
} from './MessageRepository.js';
export { MIGRATION_V2_UP_SQL } from './migrations/v2.sql.js';
export { MIGRATION_V3_UP_SQL } from './migrations/v3.sql.js';
export { MIGRATION_V4_UP_SQL } from './migrations/v4.sql.js';
export type { Migration } from './migrations.js';
export {
  getCurrentVersion,
  getMigrations,
  rollbackMigration,
  runMigrations,
} from './migrations.js';
export type { SearchHit, SearchOptions } from './SearchRepository.js';
export {
  buildMatchQuery,
  clampLimit,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SearchRepository,
} from './SearchRepository.js';
export {
  CREATE_TABLES_SQL,
  CREATE_TABLES_V1_SQL,
  DROP_TABLES_SQL,
  SCHEMA_VERSION,
} from './schema.js';
