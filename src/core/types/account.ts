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
  password?: string;
  useTls: boolean;
  authType: 'password' | 'oauth2';
  oauthConfig?: OAuthConfig;
  createdAt: Date;
  updatedAt: Date;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl: string;
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
