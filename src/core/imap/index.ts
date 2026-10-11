/**
 * IMAP service barrel export.
 *
 * Consumers should import from this module rather than from the individual
 * files so we can refactor the internals without breaking downstream code.
 */

export {
  getEnvSecretName,
  getEnvSecretSuffix,
  type ResolvedCredentials,
  redactSecrets,
  resolveCredentials,
} from './credentials.js';
export {
  classifyType,
  compareFolders,
  type FolderSyncResult,
  normalizeMailboxEntry,
  type SyncFolder,
  syncMailboxes,
} from './folders.js';
export {
  buildImapOptions,
  getImapService,
  ImapService,
  type ImapServiceOptions,
  resetImapService,
} from './ImapService.js';
export {
  buildFetchQuery,
  buildFetchRange,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MAX_SOURCE_BYTES,
  dedupeMessages,
  extractBodyAsync,
  flagsToBooleans,
  htmlToPlainText,
  mapAttachment,
  normalizeDate,
  normalizeFetchedMessage,
  normalizeMessageId,
  parseEnvelopeAddresses,
  planBatches,
  resolveLimits,
  sortNewestFirst,
} from './messages.js';
export type {
  EmailAddress,
  ImapAccountConfig,
  ImapConnectionOptions,
  ImapFlowFactory,
  ImapFolderInfo,
  MessageSyncLimits,
  MessageSyncOptions,
  MessageSyncResult,
  SyncAttachment,
  SyncMessage,
} from './types.js';
