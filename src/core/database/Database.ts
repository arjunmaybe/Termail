/**
 * Database connection and initialization using bun:sqlite
 */

import { Database as BunDatabase, type SQLQueryBindings, type Statement } from 'bun:sqlite';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabasePath } from '../types/config.js';
import type { AppConfig } from '../types/config.js';
import { DatabaseError } from '../utils/errors.js';
import { ensureTermailDataDirSync, hardenDatabaseFiles } from '../utils/filePermissions.js';
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
      // bun:sqlite creates the file with default permissions; harden it
      // immediately. Failures throw (fail closed) rather than continuing
      // with a world-readable database. A `0700` directory bounds exposure
      // only for Termail-managed/newly created paths; pre-existing custom
      // directories are deliberately left untouched, so sidecars created
      // later there inherit the umask (sidecars present now are hardened
      // individually below).
      hardenDatabaseFiles(this.dbPath);
      this.initialized = true; // mark initialized before internal calls
      this.configurePragmas();
      runMigrations(this.db);
      // Re-harden: migration writes can create -wal/-shm sidecars after
      // the first call. Only permission bits are touched.
      hardenDatabaseFiles(this.dbPath);
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
   * Ensure database directory exists. New directories are created `0700`;
   * a pre-existing leaf is additionally hardened to `0700` only when it
   * is a dedicated Termail data directory (arbitrary custom-path parents
   * are never rechmodded; see filePermissions). Permission failures on
   * the dedicated directory throw and abort initialization.
   */
  private async ensureDatabaseDir(): Promise<void> {
    ensureTermailDataDirSync(dirname(this.dbPath));
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
