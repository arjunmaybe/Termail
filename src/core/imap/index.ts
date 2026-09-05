/**
 * IMAP service barrel export.
 *
 * Consumers should import from this module rather than from the individual
 * files so we can refactor the internals without breaking downstream code.
 */

export type {
  ImapAccountConfig,
  ImapConnectionOptions,
  ImapFolderInfo,
  ImapFlowFactory,
  EmailAddress,
  SyncAttachment,
  SyncMessage,
  MessageSyncResult,
  MessageSyncLimits,
  MessageSyncOptions,
} from './types.js';
export {
  type ResolvedCredentials,
  getEnvSecretName,
  getEnvSecretSuffix,
  redactSecrets,
  resolveCredentials,
} from './credentials.js';
export {
  type FolderSyncResult,
  type SyncFolder,
  classifyType,
  compareFolders,
  normalizeMailboxEntry,
  syncMailboxes,
} from './folders.js';
export {
  buildFetchQuery,
  buildFetchRange,
  dedupeMessages,
  extractBodyAsync,
  htmlToPlainText,
  mapAttachment,
  normalizeDate,
  normalizeFetchedMessage,
  normalizeMessageId,
  parseEnvelopeAddresses,
  planBatches,
  resolveLimits,
  sortNewestFirst,
  flagsToBooleans,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MAX_SOURCE_BYTES,
} from './messages.js';
export {
  ImapService,
  type ImapServiceOptions,
  buildImapOptions,
  getImapService,
  resetImapService,
} from './ImapService.js';
