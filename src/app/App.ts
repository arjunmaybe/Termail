/**
 * Root application component - OpenTUI 0.4.x class-based renderable
 */

import { BoxRenderable, type RenderContext, TextRenderable } from '@opentui/core';
import { getConfigStore } from '../core/config/ConfigStore.js';
import { getDatabase } from '../core/database/Database.js';
import { actions, subscribe } from '../core/state/AppState.js';
import { logger } from '../core/utils/logger.js';
import { ContentPane } from './layout/ContentPane.js';
import { Sidebar } from './layout/Sidebar.js';
import { StatusBar } from './layout/StatusBar.js';
import { type Theme, getTheme } from './theme.js';

export interface AppOptions {
  /** Initial theme mode; defaults to dark. */
  initialTheme?: 'dark' | 'light';
}

export class App extends BoxRenderable {
  private theme: Theme;
  private themeMode: 'dark' | 'light';
  private sidebar: Sidebar;
  private content: ContentPane;
  private statusBar: StatusBar;
  private banner: TextRenderable;
  private errorBanner: TextRenderable;
  private initialized = false;
  private initError: string | null = null;

  constructor(ctx: RenderContext, options: AppOptions & { id?: string } = {}) {
    super(ctx, {
      id: 'app-root',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      backgroundColor: '#000000',
      ...options,
    });

    this.themeMode = options.initialTheme ?? 'dark';
    this.theme = getTheme(this.themeMode);

    // Banner shown during init or on error (replaced once initialized)
    this.banner = new TextRenderable(ctx, {
      id: 'init-banner',
      content: 'Initializing termail...',
      fg: this.theme.textPrimary,
      width: '100%',
      height: 1,
    });
    this.errorBanner = new TextRenderable(ctx, {
      id: 'error-banner',
      content: '',
      fg: this.theme.error,
      width: '100%',
      height: 1,
    });

    // Main three-pane layout: sidebar + content + status bar
    this.sidebar = new Sidebar(ctx, { id: 'sidebar', themeMode: this.themeMode });
    this.content = new ContentPane(ctx, { id: 'content-pane', themeMode: this.themeMode });
    this.statusBar = new StatusBar(ctx, { id: 'status-bar', themeMode: this.themeMode });

    this.sidebar.visible = false;
    this.content.visible = false;
    this.statusBar.visible = false;
    this.errorBanner.visible = false;

    this.add(this.banner);
    this.add(this.errorBanner);
    this.add(this.sidebar);
    this.add(this.content);
    this.add(this.statusBar);

    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      logger.info('Initializing application...');

      const configStore = getConfigStore();
      const config = await configStore.initialize();
      this.themeMode = config.ui.theme;
      this.theme = getTheme(this.themeMode);

      const database = getDatabase(config);
      await database.initialize();

      // Phase 1 ships with no accounts configured
      actions.setAccounts([]);

      this.initialized = true;
      this.banner.visible = false;
      this.sidebar.visible = true;
      this.content.visible = true;
      this.statusBar.visible = true;
      this.errorBanner.visible = false;
      this.applyTheme(this.theme);
      logger.info('Application initialized successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Initialization failed', { error: message });
      this.initError = message;
      this.errorBanner.content = `Initialization Error: ${message}  (press q to quit)`;
      this.banner.visible = false;
      this.errorBanner.visible = true;
    }
  }

  /** Re-paint children with the current theme. */
  private applyTheme(theme: Theme): void {
    this.theme = theme;
    this.backgroundColor = theme.background;
    this.sidebar.setTheme(theme);
    this.content.setTheme(theme);
    this.statusBar.setTheme(theme);
  }

  /** Public entry point so main.ts can wire up state subscriptions. */
  attach(): () => void {
    return subscribe(() => {
      // Re-apply theme if it changed via actions
      const newTheme = getTheme(this.themeMode);
      this.applyTheme(newTheme);
    });
  }

  isInitialized(): boolean {
    return this.initialized;
  }
  getInitError(): string | null {
    return this.initError;
  }
  getThemeMode(): 'dark' | 'light' {
    return this.themeMode;
  }
  getSidebar(): Sidebar {
    return this.sidebar;
  }
  getContent(): ContentPane {
    return this.content;
  }
  getStatusBar(): StatusBar {
    return this.statusBar;
  }
}
