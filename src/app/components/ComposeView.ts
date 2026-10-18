/**
 * Phase 4 — `ComposeView`.
 *
 * The full-screen composer. While active it replaces the entire normal
 * shell (header, sidebar/content, search bar, status bar); `App` owns the
 * show/hide of those siblings. This component owns only its own chrome and
 * the native editors.
 *
 * Layers:
 *   - To/Cc/Bcc/Subject use `InputRenderable` (single line).
 *   - Body uses `TextareaRenderable` (multiline, word wrap).
 *   Native cursor navigation, selection, undo/redo and paste are therefore
 *   inherited unchanged.
 *
 * Focus is state-driven: `selectors.composeFocus` is the single source of
 * truth. The view syncs its native focus from it, which keeps the key
 * router and the editors in agreement (the router decides Enter/Tab/etc.
 * based on the same signal).
 *
 * State/editor sync:
 *   - User edits flow editor -> `onFieldInput` -> `AppState`.
 *   - Programmatic values (plain `openCompose`, or the atomic AI draft
 *     open) flow `AppState` -> editor exactly once per `composeRevision`,
 *     guarded by `applying` so the induced content-change callbacks never
 *     echo back. Recipient field text is never rewritten from the parsed
 *     array during normal typing, so a trailing comma survives.
 */

import {
  BoxRenderable,
  InputRenderable,
  type RenderContext,
  TextAttributes,
  TextareaRenderable,
  TextRenderable,
} from '@opentui/core';
import { type ComposeField, selectors, subscribe } from '../../core/state/AppState.js';
import { sanitizeForTerminal } from '../../core/utils/terminal.js';
import type { Theme } from '../theme.js';
import { getTheme } from '../theme.js';

/** Fields backed by a native editor (Send is a routing target, not an editor). */
export type ComposeEditableField = Exclude<ComposeField, 'send'>;

export interface ComposeViewOptions {
  themeMode: 'dark' | 'light';
  /** Push editor text into application state (called on user edits). */
  onFieldInput: (field: ComposeEditableField, text: string) => void;
  id?: string;
}

/** Tab-cycle order; the Send target is a real stop so Enter/Space can send. */
export const COMPOSE_FIELD_ORDER: readonly ComposeField[] = [
  'to',
  'cc',
  'bcc',
  'subject',
  'body',
  'send',
];

export class ComposeView extends BoxRenderable {
  private theme: Theme;
  private readonly onFieldInput: (field: ComposeEditableField, text: string) => void;

  private titleText: TextRenderable;
  private toInput: InputRenderable;
  private ccInput: InputRenderable;
  private bccInput: InputRenderable;
  private subjectInput: InputRenderable;
  private bodyTextarea: TextareaRenderable;
  private sendTarget: BoxRenderable;
  private sendLabel: TextRenderable;
  private statusText: TextRenderable;
  private confirmText: TextRenderable;
  private hintsText: TextRenderable;

  private unsubscribe: (() => void) | null = null;

  /** True while applying AppState values to the editors (suppresses echo). */
  private applying = false;
  /**
   * Last text value written to / reported from each editor. Used to drop
   * deferred programmatic content-change echoes.
   */
  private readonly lastReported: Record<ComposeEditableField, string> = {
    to: '',
    cc: '',
    bcc: '',
    subject: '',
    body: '',
  };
  private lastRevision = -1;
  private lastFocusedField: ComposeField | null = null;

  constructor(ctx: RenderContext, options: ComposeViewOptions) {
    const theme = getTheme(options.themeMode);
    super(ctx, {
      id: options.id ?? 'compose-view',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      backgroundColor: theme.background,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
    });

    this.theme = theme;
    this.onFieldInput = options.onFieldInput;

    this.titleText = new TextRenderable(ctx, {
      id: 'compose-title',
      content: 'New message',
      fg: theme.primary,
      attributes: TextAttributes.BOLD,
      width: '100%',
      height: 1,
    });

    this.toInput = this.createInput(ctx, 'compose-to', 'to', 'recipient@example.com');
    this.ccInput = this.createInput(ctx, 'compose-cc', 'cc', '');
    this.bccInput = this.createInput(ctx, 'compose-bcc', 'bcc', '');
    this.subjectInput = this.createInput(ctx, 'compose-subject', 'subject', 'Subject');

    this.bodyTextarea = new TextareaRenderable(ctx, {
      id: 'compose-body',
      flexGrow: 1,
      width: '100%',
      wrapMode: 'word',
      textColor: theme.textPrimary,
      backgroundColor: theme.surface,
      focusedBackgroundColor: theme.surfaceHover,
      focusedTextColor: theme.textPrimary,
      placeholder: 'Write your message…',
      placeholderColor: theme.textMuted,
      onContentChange: () => this.handleContentChange('body'),
    });

    const bodyBox = new BoxRenderable(ctx, {
      id: 'compose-body-box',
      flexDirection: 'column',
      width: '100%',
      flexGrow: 1,
      borderStyle: 'single',
      borderColor: theme.border,
      paddingLeft: 1,
      paddingRight: 1,
    });
    bodyBox.add(
      new TextRenderable(ctx, {
        id: 'compose-body-label',
        content: 'Body',
        fg: theme.textSecondary,
        width: '100%',
        height: 1,
      })
    );
    bodyBox.add(this.bodyTextarea);

    this.sendTarget = new BoxRenderable(ctx, {
      id: 'compose-send',
      flexDirection: 'row',
      width: '100%',
      height: 1,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: theme.surface,
    });
    this.sendLabel = new TextRenderable(ctx, {
      id: 'compose-send-label',
      content: 'Send   (Enter / Space)',
      fg: theme.textPrimary,
    });
    this.sendTarget.add(this.sendLabel);

    this.statusText = new TextRenderable(ctx, {
      id: 'compose-status',
      content: '',
      fg: theme.textMuted,
      width: '100%',
      height: 1,
    });
    this.confirmText = new TextRenderable(ctx, {
      id: 'compose-confirm',
      content: '',
      fg: theme.warning,
      width: '100%',
      height: 1,
    });
    this.hintsText = new TextRenderable(ctx, {
      id: 'compose-hints',
      content:
        'Tab: next field · Shift+Tab: previous · Enter: next field · Ctrl+Enter: send · Esc / Ctrl+C: discard',
      fg: theme.textMuted,
      width: '100%',
      height: 1,
    });

    this.add(this.titleText);
    this.add(this.fieldRow(ctx, 'To', this.toInput));
    this.add(this.fieldRow(ctx, 'Cc', this.ccInput));
    this.add(this.fieldRow(ctx, 'Bcc', this.bccInput));
    this.add(this.fieldRow(ctx, 'Subject', this.subjectInput));
    this.add(bodyBox);
    this.add(this.sendTarget);
    this.add(this.statusText);
    this.add(this.confirmText);
    this.add(this.hintsText);

    this.unsubscribe = subscribe(() => this.refresh());
    this.refresh();
  }

  private createInput(
    ctx: RenderContext,
    id: string,
    field: ComposeEditableField,
    placeholder: string
  ): InputRenderable {
    return new InputRenderable(ctx, {
      id,
      flexGrow: 1,
      value: '',
      placeholder,
      textColor: this.theme.textPrimary,
      backgroundColor: this.theme.surface,
      focusedBackgroundColor: this.theme.surfaceHover,
      focusedTextColor: this.theme.textPrimary,
      placeholderColor: this.theme.textMuted,
      onContentChange: () => this.handleContentChange(field),
    });
  }

  private fieldRow(ctx: RenderContext, label: string, editor: InputRenderable): BoxRenderable {
    const row = new BoxRenderable(ctx, {
      id: `compose-row-${label.toLowerCase()}`,
      flexDirection: 'row',
      width: '100%',
      height: 1,
      paddingRight: 1,
    });
    row.add(
      new TextRenderable(ctx, {
        content: `${label}:`,
        fg: this.theme.textSecondary,
        width: 9,
        flexShrink: 0,
      })
    );
    row.add(editor);
    return row;
  }

  // -- state -> view -------------------------------------------------

  private refresh(): void {
    const active = selectors.composeActive;
    const revision = selectors.composeRevision;

    if (active && revision !== this.lastRevision) {
      this.applyFieldsFromState();
      this.lastFocusedField = null;
      // Consume the revision only when it is actually applied, so a
      // revision bump written just before `composeActive` rises is not
      // swallowed while the composer is still inactive.
      this.lastRevision = revision;
    }

    this.titleText.content = this.buildTitle();
    this.updateSendHighlight();
    this.updateStatus();
    this.updateConfirm();

    if (active) {
      const focus = selectors.composeFocus;
      if (focus !== this.lastFocusedField) {
        this.focusField(focus);
        this.lastFocusedField = focus;
      }
    } else if (this.lastFocusedField !== null) {
      this.blurAllEditors();
      this.lastFocusedField = null;
    }
  }

  private buildTitle(): string {
    return /^re:/i.test(selectors.composeSubject.trim()) ? 'Reply' : 'New message';
  }

  private applyFieldsFromState(): void {
    this.applying = true;
    try {
      const to = selectors.composeTo.join(', ');
      const cc = selectors.composeCc.join(', ');
      const bcc = selectors.composeBcc.join(', ');
      const subject = selectors.composeSubject;
      const body = selectors.composeBody;
      // Only write when the text actually differs: a needless `setText`
      // still emits an (async) content-change event, and that echo must
      // never be interpreted as a user edit.
      if (this.toInput.value !== to) this.toInput.value = to;
      if (this.ccInput.value !== cc) this.ccInput.value = cc;
      if (this.bccInput.value !== bcc) this.bccInput.value = bcc;
      if (this.subjectInput.value !== subject) this.subjectInput.value = subject;
      if (this.bodyTextarea.plainText !== body) this.bodyTextarea.setText(body);
      // Record what we wrote so a deferred content-change echo for this
      // value is ignored instead of overwriting newer state.
      this.lastReported.to = to;
      this.lastReported.cc = cc;
      this.lastReported.bcc = bcc;
      this.lastReported.subject = subject;
      this.lastReported.body = body;
    } finally {
      this.applying = false;
    }
  }

  private updateSendHighlight(): void {
    const focused = selectors.composeFocus === 'send';
    this.sendTarget.backgroundColor = focused ? this.theme.primary : this.theme.surface;
    this.sendLabel.fg = focused ? this.theme.textInverse : this.theme.textPrimary;
  }

  private updateStatus(): void {
    if (selectors.composeSending) {
      this.statusText.content = 'Sending…';
      this.statusText.fg = this.theme.warning;
      return;
    }
    const error = selectors.composeError;
    if (error) {
      const firstLine = error.split('\n')[0]?.trim() ?? '';
      this.statusText.content = sanitizeForTerminal(`Error: ${firstLine}`);
      this.statusText.fg = this.theme.error;
      return;
    }
    this.statusText.content = '';
  }

  private updateConfirm(): void {
    if (selectors.composeConfirmDiscard) {
      this.confirmText.content = 'Discard this message?   y: discard   n / Esc: keep editing';
    } else {
      this.confirmText.content = '';
    }
  }

  // -- editor -> state -----------------------------------------------

  /** The editor's current text for an editable field. */
  private readField(field: ComposeEditableField): string {
    if (field === 'body') return this.bodyTextarea.plainText;
    const input = this.editorFor(field) as InputRenderable | null;
    return input ? input.value : '';
  }

  private handleContentChange(field: ComposeEditableField): void {
    if (this.applying) return;
    // A programmatic `setText`/`value` write can emit its content-change
    // event asynchronously, after `applying` has cleared. Comparing against
    // the last value we wrote (or reported) makes that echo a no-op, so it
    // can never clobber newer state.
    const text = this.readField(field);
    if (text === this.lastReported[field]) return;
    this.lastReported[field] = text;
    this.onFieldInput(field, text);
  }

  /**
   * Read the editors' current text into application state. Called right
   * before sending so a keystroke whose content-change callback has not
   * run yet can never make the sent body/recipients stale.
   */
  syncStateFromEditors(): void {
    for (const field of ['to', 'cc', 'bcc', 'subject', 'body'] as const) {
      const text = this.readField(field);
      this.lastReported[field] = text;
      this.onFieldInput(field, text);
    }
  }

  // -- focus ----------------------------------------------------------

  private editorFor(field: ComposeEditableField): InputRenderable | TextareaRenderable | null {
    switch (field) {
      case 'to':
        return this.toInput;
      case 'cc':
        return this.ccInput;
      case 'bcc':
        return this.bccInput;
      case 'subject':
        return this.subjectInput;
      case 'body':
        return this.bodyTextarea;
    }
  }

  private blurAllEditors(): void {
    for (const editor of [
      this.toInput,
      this.ccInput,
      this.bccInput,
      this.subjectInput,
      this.bodyTextarea,
    ]) {
      if (editor.focused) editor.blur();
    }
  }

  private focusField(field: ComposeField): void {
    // OpenTUI does not auto-blur the previously focused renderable; every
    // focused editor would otherwise receive the same keypress.
    this.blurAllEditors();
    if (field === 'send') return;
    this.editorFor(field)?.focus();
  }

  // -- public API -----------------------------------------------------

  /** The native editor backing `field`, or null for the Send target. */
  getEditor(field: ComposeField): InputRenderable | TextareaRenderable | null {
    if (field === 'send') return null;
    return this.editorFor(field);
  }

  getSendTarget(): BoxRenderable {
    return this.sendTarget;
  }

  /** Sanitized status line text (sending/error), or '' when idle. */
  getStatusText(): string {
    return this.statusText.plainText;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.backgroundColor = theme.background;
    this.titleText.fg = theme.primary;
    this.hintsText.fg = theme.textMuted;
    this.statusText.fg = theme.textMuted;
    this.confirmText.fg = theme.warning;
    this.bodyTextarea.textColor = theme.textPrimary;
    this.bodyTextarea.backgroundColor = theme.surface;
    this.bodyTextarea.focusedBackgroundColor = theme.surfaceHover;
    this.bodyTextarea.focusedTextColor = theme.textPrimary;
    this.updateSendHighlight();
    this.updateStatus();
  }

  override destroy(): void {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    this.toInput.destroy();
    this.ccInput.destroy();
    this.bccInput.destroy();
    this.subjectInput.destroy();
    this.bodyTextarea.destroy();
    this.sendTarget.destroy();
    this.statusText.destroy();
    this.confirmText.destroy();
    this.hintsText.destroy();
    this.titleText.destroy();
    super.destroy();
  }
}
