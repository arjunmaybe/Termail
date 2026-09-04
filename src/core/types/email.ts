/**
 * Core email types for termail
 */

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface EmailEnvelope {
  id: string;
  accountId: string;
  folderId: string;
  messageId: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  date: Date;
  isRead: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  size: number;
}

export interface Email extends EmailEnvelope {
  bodyText?: string;
  bodyHtml?: string;
  headers: Record<string, string>;
  attachments: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  contentId?: string;
  content: Uint8Array;
}

export interface EmailListParams {
  accountId?: string;
  folderId?: string;
  limit?: number;
  offset?: number;
  searchQuery?: string;
  includeRead?: boolean;
  includeUnread?: boolean;
  sortBy?: 'date' | 'subject' | 'from' | 'size';
  sortOrder?: 'asc' | 'desc';
}
