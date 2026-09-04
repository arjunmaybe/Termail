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
import type { EmailEnvelope } from '../../core/types/email.js';
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
    this.emailDetail = this.buildEmptyDetail(ctx);

    this.container.add(this.welcomeView);
    this.container.add(this.emailListView);
    this.container.add(this.emailDetail);

    this.add(this.container);

    this.unsubscribe = subscribe(() => {
      this.refresh();
    });

    this.refresh();
  }

  private buildEmptyDetail(ctx: RenderContext): BoxRenderable {
    const root = new BoxRenderable(ctx, {
      id: 'email-detail',
      flexDirection: 'column',
      width: '100%',
      padding: 1,
    });
    const subject = new TextRenderable(ctx, {
      id: 'email-detail-subject',
      content: '(no subject)',
      fg: this.theme.textPrimary,
      attributes: TextAttributes.BOLD,
    });
    const from = new TextRenderable(ctx, {
      id: 'email-detail-from',
      content: '',
      fg: this.theme.textSecondary,
    });
    const to = new TextRenderable(ctx, {
      id: 'email-detail-to',
      content: '',
      fg: this.theme.textSecondary,
    });
    const date = new TextRenderable(ctx, {
      id: 'email-detail-date',
      content: '',
      fg: this.theme.textMuted,
    });
    const separator = new TextRenderable(ctx, {
      id: 'email-detail-sep',
      content: '',
      fg: this.theme.border,
    });
    const body = new TextRenderable(ctx, {
      id: 'email-detail-body',
      content: '',
      fg: this.theme.textPrimary,
    });

    root.add(subject);
    root.add(from);
    root.add(to);
    root.add(date);
    root.add(separator);
    root.add(body);
    return root;
  }

  private refresh(): void {
    const selectedId = selectors.selectedEmailId;
    const currentFolder = selectors.currentFolder;

    if (selectedId) {
      const email = selectors.emails.find((e) => e.id === selectedId);
      if (email) {
        this.showDetail(email);
        return;
      }
    }

    this.welcomeView.visible = !currentFolder;
    this.emailListView.visible = !!currentFolder;
    this.emailDetail.visible = false;
  }

  private showDetail(email: EmailEnvelope): void {
    this.welcomeView.visible = false;
    this.emailListView.visible = false;
    this.emailDetail.visible = true;

    const subject = this.emailDetail.findDescendantById('email-detail-subject') as
      | TextRenderable
      | undefined;
    const from = this.emailDetail.findDescendantById('email-detail-from') as
      | TextRenderable
      | undefined;
    const to = this.emailDetail.findDescendantById('email-detail-to') as TextRenderable | undefined;
    const date = this.emailDetail.findDescendantById('email-detail-date') as
      | TextRenderable
      | undefined;
    const separator = this.emailDetail.findDescendantById('email-detail-sep') as
      | TextRenderable
      | undefined;
    const body = this.emailDetail.findDescendantById('email-detail-body') as
      | TextRenderable
      | undefined;

    if (subject) subject.content = email.subject || '(no subject)';
    if (from) from.content = `From: ${formatAddresses(email.from)}`;
    if (to) to.content = `To: ${formatAddresses(email.to)}`;
    if (date) date.content = email.date.toLocaleString();
    if (separator) separator.content = '─'.repeat(Math.max(0, this.width - 4));
    if (body) body.content = ''; // Email body not stored in Phase 1 envelope
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.themeMode = theme === getTheme('dark') ? 'dark' : 'light';
    this.backgroundColor = theme.background;
    this.container.backgroundColor = theme.background;
    this.welcomeView.setTheme(theme);
    this.emailListView.setTheme(theme);
  }

  override destroy(): void {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    super.destroy();
  }
}

function formatAddresses(addrs: { name?: string; address: string }[]): string {
  if (addrs.length === 0) return '(none)';
  return addrs.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
}
