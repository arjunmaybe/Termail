/**
 * Local type declarations for `mailparser`.
 *
 * `mailparser` ships JavaScript only; the upstream repo does not
 * publish `.d.ts` files. We declare only the surface this codebase
 * uses. Keep the declarations narrow so we don't take on maintenance
 * burden for parts of the library we don't consume.
 */

declare module 'mailparser' {
  export interface MailparserAddress {
    name?: string;
    address?: string;
  }

  export interface MailparserAttachment {
    filename?: string;
    contentType?: string;
    size?: number;
    contentDisposition?: string;
    contentId?: string;
  }

  export interface ParsedMail {
    text?: string;
    html?: string | boolean;
    attachments?: MailparserAttachment[];
    from?: MailparserAddress | MailparserAddress[];
    to?: MailparserAddress | MailparserAddress[];
    cc?: MailparserAddress | MailparserAddress[];
    subject?: string;
    messageId?: string;
    date?: Date;
  }

  export function simpleParser(source: Buffer | string): Promise<ParsedMail>;
}
