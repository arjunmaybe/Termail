/**
 * Vitest global setup
 */

import { afterAll, beforeAll, vi } from 'vitest';
import { resetConfigStore } from '../core/config/ConfigStore.js';
import { resetDatabase } from '../core/database/Database.js';
import { logger, setLogLevel, setTestMode } from '../core/utils/logger.js';

// Enable test mode for logger
setTestMode(true);
setLogLevel('error');

// Reset singletons before each test
beforeAll(() => {
  resetConfigStore();
  resetDatabase();
});

afterAll(() => {
  resetConfigStore();
  resetDatabase();
});

// Mock console methods to reduce noise in tests
const originalConsole = { ...console };
beforeAll(() => {
  console.log = vi.fn();
  console.warn = vi.fn();
  console.error = vi.fn();
});

afterAll(() => {
  Object.assign(console, originalConsole);
});
