/**
 * App component tests
 *
 * These tests only exercise the parts of App that can be tested without
 * a live terminal: the constructor wiring and the state-driven methods.
 */

import { describe, expect, it } from 'vitest';
import { App } from '../../src/app/App.js';
import { resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { resetDatabase } from '../../src/core/database/Database.js';
import { actions, selectors, subscribe } from '../../src/core/state/AppState.js';

describe('App module', () => {
  it('should export the App class', () => {
    expect(App).toBeDefined();
    expect(typeof App).toBe('function');
  });
});

describe('AppState selectors', () => {
  it('exposes a subscribe function that returns an unsubscribe', () => {
    const calls: number[] = [];
    const unsub = selectors.subscribe(() => {
      calls.push(1);
    });
    expect(typeof unsub).toBe('function');
    actions.setSidebarCollapsed(true);
    actions.setSidebarCollapsed(false);
    expect(calls.length).toBeGreaterThan(0);
    unsub();
  });

  it('allows subscribing directly via the module export', () => {
    const calls: number[] = [];
    const unsub = subscribe(() => calls.push(1));
    actions.toggleSidebar();
    expect(calls.length).toBeGreaterThan(0);
    unsub();
  });

  it('exposes all expected getter selectors', () => {
    expect(selectors).toBeDefined();
    expect(Array.isArray(selectors.accounts)).toBe(true);
    expect(Array.isArray(selectors.folders)).toBe(true);
    expect(Array.isArray(selectors.emails)).toBe(true);
    expect(typeof selectors.currentAccountId).toBe('object'); // null
    expect(typeof selectors.currentFolderId).toBe('object');
    expect(typeof selectors.selectedEmailId).toBe('object');
    expect(typeof selectors.unreadCount).toBe('number');
    expect(typeof selectors.flaggedCount).toBe('number');
  });
});

describe('Global cleanup', () => {
  it('resetConfigStore and resetDatabase are callable', () => {
    expect(() => resetConfigStore()).not.toThrow();
    expect(() => resetDatabase()).not.toThrow();
  });
});
