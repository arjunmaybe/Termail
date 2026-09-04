/**
 * Database connection and initialization using bun:sqlite
 */

import { Database as BunDatabase, type SQLQueryBindings, type Statement } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDatabasePath } from '../types/config.js';
import type { AppConfig } from '../types/config.js';
import { DatabaseError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { getCurrentVersion, runMigrations } from './migrations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class Database {
  private db: BunDatabase | null = null;
  private dbPath: string;
  private initialized = false;

  constructor(config: AppConfig) {
    this.dbPath = getDatabasePath(config);
  }

  /**
   * Initialize database connection and run migrations
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await this.ensureDatabaseDir();
      this.db = new BunDatabase(this.dbPath);
      this.initialized = true; // mark initialized before internal calls
      this.configurePragmas();
      runMigrations(this.db);
      logger.info('Database initialized', {
        path: this.dbPath,
        version: getCurrentVersion(this.db),
      });
    } catch (error) {
      this.initialized = false;
      this.db = null;
      logger.error('Failed to initialize database', { error });
      throw new DatabaseError(`Failed to initialize database: ${error}`);
    }
  }

  /**
   * Get the underlying database instance
   */
  getInstance(): BunDatabase {
    if (!this.db) {
      throw new DatabaseError('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  /**
   * Execute a query with parameters bound at call time.
   *
   * Mirrors `bun:sqlite`'s `db.query(sql).all(...args)` API rather than the
   * typical `(sql, params)` signature, because the underlying `Statement`
   * ignores constructor params and binds values only when `.all` / `.get` /
   * `.run` are called.
   */
  query<T = Record<string, unknown>>(sql: string): Statement<T, SQLQueryBindings[]> {
    return this.getInstance().query<T, SQLQueryBindings[]>(sql);
  }

  /**
   * Execute a statement (no results)
   */
  exec(sql: string): void {
    this.getInstance().exec(sql);
  }

  /**
   * Run a function in a transaction
   */
  transaction<T>(fn: () => T): T {
    return this.getInstance().transaction(fn)();
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.initialized = false;
      logger.info('Database closed');
    }
  }

  /**
   * Get database path
   */
  getPath(): string {
    return this.dbPath;
  }

  /**
   * Check if database is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Configure SQLite pragmas for performance
   */
  private configurePragmas(): void {
    const db = this.getInstance();
    // WAL mode for better concurrency
    db.exec('PRAGMA journal_mode = WAL');
    // Normal synchronous for balance of safety/performance
    db.exec('PRAGMA synchronous = NORMAL');
    // Cache size: 32MB
    db.exec('PRAGMA cache_size = -32768');
    // Memory map size: 256MB
    db.exec('PRAGMA mmap_size = 268435456');
    // Page size: 4KB (default)
    // db.exec('PRAGMA page_size = 4096');
    // Foreign keys enforcement
    db.exec('PRAGMA foreign_keys = ON');
    // Temp store in memory
    db.exec('PRAGMA temp_store = MEMORY');
  }

  /**
   * Ensure database directory exists
   */
  private async ensureDatabaseDir(): Promise<void> {
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

// Singleton instance
let databaseInstance: Database | null = null;

export function getDatabase(config: AppConfig): Database {
  if (!databaseInstance) {
    databaseInstance = new Database(config);
  }
  return databaseInstance;
}

export function resetDatabase(): void {
  if (databaseInstance) {
    databaseInstance.close();
    databaseInstance = null;
  }
}
