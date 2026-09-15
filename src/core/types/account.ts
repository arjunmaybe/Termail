/**
 * Account and folder types for termail
 */

export type AccountType = 'imap' | 'local';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  email: string;
  host?: string;
  port?: number;
  username?: string;
  // Credentials are never stored here. Passwords / OAuth tokens are
  // resolved from environment variables at connect/send time (see
  // `core/imap/credentials.ts` and `core/ai/credentials.ts`).
  useTls: boolean;
  authType: 'password' | 'oauth2';
  // SMTP settings (Phase 4, optional, never inferred from IMAP fields).
  smtpHost?: string;
  smtpPort?: number;
  smtpMode?: 'implicit-tls' | 'starttls';
  createdAt: Date;
  updatedAt: Date;
}

export interface Folder {
  id: string;
  accountId: string;
  name: string;
  fullName: string;
  type: FolderType;
  parentId?: string;
  delimiter: string;
  attributes: FolderAttribute[];
  unreadCount: number;
  totalCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export type FolderType =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'archive'
  | 'trash'
  | 'spam'
  | 'starred'
  | 'important'
  | 'custom';

export type FolderAttribute =
  | '\\Inbox'
  | '\\Sent'
  | '\\Drafts'
  | '\\Archive'
  | '\\Trash'
  | '\\Junk'
  | '\\Flagged'
  | '\\Important'
  | '\\All'
  | string;

export interface AccountWithFolders extends Account {
  folders: Folder[];
}
