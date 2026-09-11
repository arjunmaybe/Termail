/**
 * Content pane - main email viewing area
 */

import {
  BoxRenderable,
  type RenderContext,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
} from '@opentui/core';
import { selectors, subscribe } from '../../core/state/AppState.js';
import type { PersistedEmail } from '../../core/database/index.js';
import type { EmailAddress } from '../../core/types/email.js';
import { EmailListView } from '../components/EmailListView.js';
import { WelcomeView } from '../components/WelcomeView.js';
import type { Theme } from '../theme.js';
import { getTheme } from '../theme.js';

export interface ContentPaneOptions {
  themeMode: 'dark' | 'light';
  id?: string;
}

export class ContentPane extends BoxRenderable {
  private theme: Theme;
  private themeMode: 'dark' | 'light';
  private container: ScrollBoxRenderable;
  private welcomeView: WelcomeView;
  private emailListView: EmailListView;
  private emailDetail: BoxRenderable;
  private detailSubject: TextRenderable;
  private detailFrom: TextRenderable;
  private detailTo: TextRenderable;
  private detailCc: TextRenderable;
  private detailDate: TextRenderable;
  private detailAttachments: TextRenderable;
  private detailSeparator: TextRenderable;
  private detailBody: TextRenderable;
  // Phase 5 — AI result section (detail pane only, no new UI system).
  private aiSeparator: TextRenderable;
  private aiHeader: TextRenderable;
  private aiBody: TextRenderable;
  private unsubscribe: (() => void) | null = null;

  constructor(ctx: RenderContext, options: ContentPaneOptions) {
    const theme = getTheme(options.themeMode);
    super(ctx, {
      id: options.id ?? 'content-pane',
      flexDirection: 'column',
      flexGrow: 1,
      height: '100%',
      backgroundColor: theme.background,
    });

    this.theme = theme;
    this.themeMode = options.themeMode;

    this.container = new ScrollBoxRenderable(ctx, {
      id: 'content-scroll',
      width: '100%',
      flexGrow: 1,
      backgroundColor: theme.background,
      scrollY: true,
    });

    this.welcomeView = new WelcomeView(ctx, { id: 'welcome-view', themeMode: this.themeMode });
    this.emailListView = new EmailListView(ctx, {
      id: 'email-list-view',
      themeMode: this.themeMode,
    });
    this.detailSubject = new TextRenderable(ctx, {
      id: 'email-detail-subject',
      content: '(no subject)',
      fg: theme.textPrimary,
      attributes: TextAttributes.BOLD,
    });
    this.detailFrom = new TextRenderable(ctx, {
      id: 'email-detail-from',
      content: '',
      fg: theme.textSecondary,
    });
    this.detailTo = new TextRenderable(ctx, {
      id: 'email-detail-to',
      content: '',
      fg: theme.textSecondary,
    });
    this.detailCc = new TextRenderable(ctx, {
      id: 'email-detail-cc',
      content: '',
      fg: theme.textSecondary,
    });
    this.detailDate = new TextRenderable(ctx, {
      id: 'email-detail-date',
      content: '',
      fg: theme.textMuted,
    });
    this.detailAttachments = new TextRenderable(ctx, {
      id: 'email-detail-attachments',
      content: '',
      fg: theme.textMuted,
    });
    this.detailSeparator = new TextRenderable(ctx, {
      id: 'email-detail-sep',
      content: '',
      fg: theme.border,
    });
    this.detailBody = new TextRenderable(ctx, {
      id: 'email-detail-body',
      content: '',
      fg: theme.textPrimary,
    });
    this.aiSeparator = new TextRenderable(ctx, {
      id: 'email-detail-ai-sep',
      content: '',
      fg: theme.border,
    });
    this.aiHeader = new TextRenderable(ctx, {
      id: 'email-detail-ai-header',
      content: '',
      fg: theme.textSecondary,
      attributes: TextAttributes.BOLD,
    });
    this.aiBody = new TextRenderable(ctx, {
      id: 'email-detail-ai-body',
      content: '',
      fg: theme.textPrimary,
    });
    this.emailDetail = new BoxRenderable(ctx, {
      id: 'email-detail',
      flexDirection: 'column',
      width: '100%',
      padding: 1,
    });
    this.emailDetail.add(this.detailSubject);
    this.emailDetail.add(this.detailFrom);
    this.emailDetail.add(this.detailTo);
    this.emailDetail.add(this.detailCc);
    this.emailDetail.add(this.detailDate);
    this.emailDetail.add(this.detailAttachments);
    this.emailDetail.add(this.detailSeparator);
    this.emailDetail.add(this.detailBody);
    this.emailDetail.add(this.aiSeparator);
    this.emailDetail.add(this.aiHeader);
    this.emailDetail.add(this.aiBody);

    this.container.add(this.welcomeView);
    this.container.add(this.emailListView);
    this.container.add(this.emailDetail);

    this.add(this.container);

    this.unsubscribe = subscribe(() => {
      this.refresh();
    });

    this.refresh();
  }

  private refresh(): void {
    const selectedId = selectors.selectedEmailId;
    const currentFolder = selectors.currentFolder;

    if (selectedId) {
      const sourceEmails = selectors.searchActive
        ? (selectors.searchHits ?? [])
        : selectors.emails;

      const email = sourceEmails.find((e) => e.id === selectedId);
      if (email) {
        this.showDetail(email);
        return;
      }
    }

    this.welcomeView.visible = !currentFolder;
    this.emailListView.visible = !!currentFolder;
    this.emailDetail.visible = false;
  }

  private showDetail(email: PersistedEmail): void {
    this.welcomeView.visible = false;
    this.emailListView.visible = false;
    this.emailDetail.visible = true;

    this.detailSubject.content = email.subject || '(no subject)';
    this.detailFrom.content = `From: ${formatAddresses(email.fromAddresses)}`;
    this.detailTo.content = `To: ${formatAddresses(email.toAddresses)}`;
    this.detailCc.content =
      email.ccAddresses.length > 0
        ? `Cc: ${formatAddresses(email.ccAddresses)}`
        : '';
    this.detailDate.content = formatDate(new Date(email.date * 1000));
    this.detailAttachments.content =
      email.attachments.length > 0
        ? `Attachments: ${email.attachments
            .map((a) => formatAttachment(a))
            .join(', ')}`
        : '';
    this.detailSeparator.content = '─'.repeat(Math.max(0, this.width - 4));
    this.detailBody.content = email.bodyText && email.bodyText.length > 0
      ? email.bodyText
      : '(no body)';
    this.showAiSection(email.id);
  }

  /**
   * Phase 5 — render the AI section below the body. Visible only when the
   * AI result/error belongs to the email currently shown; stale results
   * for other emails stay hidden via the `aiEmailId` gate.
   */
  private showAiSection(emailId: string): void {
    const isCurrent = selectors.aiEmailId === emailId && emailId.length > 0;
    if (selectors.aiLoading && (isCurrent || selectors.aiEmailId === null)) {
      this.aiSeparator.content = '─'.repeat(Math.max(0, this.width - 4));
      this.aiSeparator.visible = true;
      this.aiHeader.content = 'AI: working…';
      this.aiHeader.visible = true;
      this.aiHeader.fg = this.theme.textSecondary;
      this.aiBody.content = '';
      this.aiBody.visible = false;
      return;
    }
    if (!isCurrent) {
      this.aiSeparator.visible = false;
      this.aiHeader.visible = false;
      this.aiBody.visible = false;
      return;
    }
    if (selectors.aiError) {
      this.aiSeparator.content = '─'.repeat(Math.max(0, this.width - 4));
      this.aiSeparator.visible = true;
      this.aiHeader.content = 'AI error:';
      this.aiHeader.visible = true;
      this.aiHeader.fg = this.theme.error;
      this.aiBody.content = selectors.aiError;
      this.aiBody.visible = true;
      this.aiBody.fg = this.theme.error;
      return;
    }
    if (selectors.aiResult) {
      this.aiSeparator.content = '─'.repeat(Math.max(0, this.width - 4));
      this.aiSeparator.visible = true;
      this.aiHeader.content = selectors.aiMode === 'draft' ? 'AI draft reply:' : 'AI summary:';
      this.aiHeader.visible = true;
      this.aiHeader.fg = this.theme.textSecondary;
      this.aiBody.content = selectors.aiResult;
      this.aiBody.visible = true;
      this.aiBody.fg = this.theme.textPrimary;
      return;
    }
    this.aiSeparator.visible = false;
    this.aiHeader.visible = false;
    this.aiBody.visible = false;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.themeMode = theme === getTheme('dark') ? 'dark' : 'light';
    this.backgroundColor = theme.background;
    this.container.backgroundColor = theme.background;
    this.welcomeView.setTheme(theme);
    this.emailListView.setTheme(theme);
    // Re-apply foreground colors to detail fields so the theme change
    // is visible without re-rendering the email itself.
    this.detailSubject.fg = theme.textPrimary;
    this.detailFrom.fg = theme.textSecondary;
    this.detailTo.fg = theme.textSecondary;
    this.detailCc.fg = theme.textSecondary;
    this.detailDate.fg = theme.textMuted;
    this.detailAttachments.fg = theme.textMuted;
    this.detailSeparator.fg = theme.border;
    this.detailBody.fg = theme.textPrimary;
    this.aiSeparator.fg = theme.border;
    this.aiBody.fg = theme.textPrimary;
  }

  override destroy(): void {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    this.emailListView.destroy();
    this.welcomeView.destroy();
    super.destroy();
  }
}

function formatAddresses(addrs: ReadonlyArray<EmailAddress>): string {
  if (addrs.length === 0) return '(none)';
  return addrs
    .map((a) => (a.name && a.name.length > 0 ? `${a.name} <${a.address}>` : a.address))
    .join(', ');
}

function formatAttachment(att: {
  filename: string;
  contentType: string;
  size: number;
}): string {
  const name = att.filename || 'unnamed';
  const size = formatBytes(att.size);
  return `${name} (${size})`;
}

function formatBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function formatDate(d: Date): string {
  return d.toLocaleString();
}
