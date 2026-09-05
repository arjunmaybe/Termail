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
} from './types.js';
export {
  type ResolvedCredentials,
  getEnvSecretName,
  getEnvSecretSuffix,
  redactSecrets,
  resolveCredentials,
} from './credentials.js';
export {
  ImapService,
  type ImapServiceOptions,
  buildImapOptions,
  getImapService,
  resetImapService,
} from './ImapService.js';
